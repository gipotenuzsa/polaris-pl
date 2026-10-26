import { buildSystemPrompt } from '../agent/prompt.js';
import { runAgent, type RunOutcome } from '../agent/runner.js';
import type { AppContext } from '../context.js';
import { errorMessage } from '../util/errors.js';

/** Следит за фоновыми прогонами агента: в одном диалоге одновременно идёт не больше одного. */
export class RunManager {
  private readonly active = new Map<string, Promise<void>>();

  constructor(private readonly ctx: AppContext) {}

  isRunning(conversationId: string): boolean {
    return this.active.has(conversationId);
  }

  private readonly viewed = new Map<string, number>();
  /** Текст ответа, который модель пишет прямо сейчас (стриминг): клиент подхватывает его при опросе. */
  private readonly live = new Map<string, string>();
  private readonly aborts = new Map<string, AbortController>();

  liveText(conversationId: string): string {
    return this.live.get(conversationId) ?? '';
  }

  /** Просит остановить текущий прогон; false — в этом диалоге ничего не идёт. */
  stop(conversationId: string): boolean {
    const ctrl = this.aborts.get(conversationId);
    if (!ctrl) return false;
    ctrl.abort();
    return true;
  }

  /** Клиент только что запрашивал этот диалог — значит, пользователь смотрит на экран. */
  touchViewed(conversationId: string): void {
    this.viewed.set(conversationId, this.ctx.clock().getTime());
  }

  isBeingViewed(conversationId: string, withinMs = 20_000): boolean {
    const at = this.viewed.get(conversationId);
    return at !== undefined && this.ctx.clock().getTime() - at < withinMs;
  }

  activeCount(): number {
    return this.active.size;
  }

  /**
   * Запускает job в фоне и возвращает его промис; null — прогон этого диалога уже идёт.
   * Ошибки job логируются здесь же, поэтому вызывающий может не ждать результат.
   */
  start<T>(conversationId: string, job: () => Promise<T>): Promise<T> | null {
    if (this.active.has(conversationId)) return null;
    const result = job();
    const tracked = result
      .then(
        () => undefined,
        (err: unknown) =>
          this.ctx.log.error({ err: errorMessage(err), conversationId }, 'Прогон агента завершился ошибкой'),
      )
      .finally(() => this.active.delete(conversationId));
    this.active.set(conversationId, tracked);
    return result;
  }

  /** Ждёт завершения всех прогонов (завершение работы, тесты). */
  async idle(): Promise<void> {
    while (this.active.size > 0) await Promise.allSettled([...this.active.values()]);
  }

  startChat(conversationId: string): boolean {
    const ctrl = new AbortController();
    this.aborts.set(conversationId, ctrl);
    const started = this.start(conversationId, () => this.runChat(conversationId, ctrl.signal));
    if (!started) {
      this.aborts.delete(conversationId);
      return false;
    }
    const cleanup = () => {
      if (this.aborts.get(conversationId) === ctrl) this.aborts.delete(conversationId);
      this.live.delete(conversationId);
    };
    started.then(cleanup, cleanup);
    return true;
  }

  async runChat(conversationId: string, signal?: AbortSignal): Promise<RunOutcome> {
    const app = this.ctx;
    const rows = await app.conversations.messages(conversationId, 0, 400);
    const lastUser = [...rows].reverse().find((r) => r.role === 'user');
    const system = await buildSystemPrompt(app, { mode: 'chat', query: lastUser?.content });
    try {
      const outcome = await runAgent(app, {
        conversationId,
        system,
        since: lastUser ? new Date(lastUser.created_at) : app.clock(),
        signal,
        onText: (delta) => this.live.set(conversationId, (this.live.get(conversationId) ?? '') + delta),
        onTextReset: () => this.live.delete(conversationId),
      });
      // Ответ готов, а пользователь ушёл из приложения: сообщение приходит на телефон, как в мессенджере.
      // (Запросы на подтверждение отправляются отдельным уведомлением.)
      if (outcome.status === 'done' && outcome.text.trim() && !this.isBeingViewed(conversationId)) {
        app.push.notify({
          title: 'Polaris',
          body: outcome.text.replace(/\s+/g, ' ').trim(),
          url: `/chat/${conversationId}`,
          tag: `chat-${conversationId}`,
        });
      }
      return outcome;
    } catch (err) {
      const message = errorMessage(err);
      app.log.error({ err: message, conversationId }, 'Сбой чата');
      await app.conversations.add({
        conversationId,
        role: 'assistant',
        content: `⚠️ Внутренняя ошибка: ${message}`,
        status: 'error',
      });
      return { status: 'failed', error: message };
    }
  }
}
