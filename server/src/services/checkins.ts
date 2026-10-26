import { buildSystemPrompt } from '../agent/prompt.js';
import { runAgent } from '../agent/runner.js';
import type { AppContext } from '../context.js';
import { errorMessage } from '../util/errors.js';
import { parseHHMM, zonedParts } from '../util/time.js';

const CHECKIN = `
Режим периодической проверки. Рядом нет собеседника: ты сам решаешь, есть ли что-то, о чём стоит сообщить владельцу прямо сейчас.
Сообщай только о полезном и новом: приближающееся напоминание или срок, зависшее подтверждение, важный итог задачи, свежая новость по его интересам из памяти (для этого можно выполнить один поиск). Не повторяй то, о чём уже писал в прошлых проверках, и не пиши ради вежливости.
Если сообщать нечего — ответь ровно одним словом: НИЧЕГО.
Иначе — короткое сообщение (до 5 строк) без приветствий и вопросов в конце.`;

const TOOLS = ['read_url', 'memory_search', 'note_list', 'reminder_list', 'task_list', 'get_time'];

const NOTHING = /^\s*НИЧЕГО(?![А-Яа-яЁё\w])/i; // \b в JS не понимает кириллицу

/** Тихие часы: окно может переходить через полночь (например, 22:00–08:00). */
export function inQuietHours(minutes: number, from: string, to: string): boolean {
  const a = parseHHMM(from);
  const b = parseHHMM(to);
  if (!a || !b) return false;
  const f = a.hour * 60 + a.minute;
  const t = b.hour * 60 + b.minute;
  if (f === t) return false;
  return f < t ? minutes >= f && minutes < t : minutes >= f || minutes < t;
}

/**
 * Проактивные проверки: раз в несколько часов агент сам просматривает задачи, напоминания, подтверждения и память
 * и пишет в единый разговор только если есть что сказать (иначе молчит и ничего не стоит владельцу, кроме токенов).
 */
export class CheckinsService {
  private running = false;

  constructor(private readonly ctx: AppContext) {}

  /** Вызывается планировщиком каждый тик. Возвращает true, если проверка запущена. */
  async maybeRun(now: Date): Promise<boolean> {
    const app = this.ctx;
    const s = await app.settings.getCheckins();
    if (!s.enabled || this.running) return false;
    const p = zonedParts(now, s.timezone);
    if (inQuietHours(p.hour * 60 + p.minute, s.quietFrom, s.quietTo)) return false;
    if (s.lastRunAt && now.getTime() - Date.parse(s.lastRunAt) < s.everyHours * 3_600_000) return false;
    const main = await app.conversations.main();
    if (app.runs.isRunning(main.id)) return false; // не перебиваем разговор

    await app.settings.set('checkins', { ...s, lastRunAt: now.toISOString() });
    this.running = true;
    void this.run(now)
      .catch((err: unknown) => app.log.warn({ err: errorMessage(err) }, 'Проверка не удалась'))
      .finally(() => {
        this.running = false;
      });
    return true;
  }

  /** Выполняет проверку сейчас; публикует сообщение, если есть о чём сказать. */
  async run(now = this.ctx.clock()): Promise<{ posted: boolean; text?: string }> {
    const app = this.ctx;
    const main = await app.conversations.main();
    const previous = await app.db.query<{ content: string }>(
      `select content from messages where conversation_id = $1 and provider = 'polaris-checkin' order by seq desc limit 3`,
      [main.id],
    );
    const sub = await app.conversations.create('Проверка', 'task');
    try {
      const data = await app.morning.gatherData(now);
      const earlier = previous.length ? `\n\nТвои прошлые сообщения (не повторяй их):\n${previous.map((m) => `- ${m.content.slice(0, 200)}`).join('\n')}` : '';
      await app.conversations.add({
        conversationId: sub.id,
        role: 'user',
        content: `Сделай периодическую проверку.\n\nДанные:\n${data}${earlier}`,
      });
      const system = `${await buildSystemPrompt(app, { mode: 'task', query: 'интересы предпочтения новости' })}\n${CHECKIN}`;
      const outcome = await runAgent(app, {
        conversationId: sub.id,
        system,
        since: now,
        maxSteps: 6,
        budget: { maxTokens: 40_000 },
        toolFilter: (t) => TOOLS.includes(t.name),
      });
      if (outcome.status !== 'done' || !outcome.text.trim() || NOTHING.test(outcome.text)) return { posted: false };
      const text = outcome.text.trim();
      await app.db.query(
        `insert into messages (conversation_id, role, content, provider) values ($1, 'assistant', $2, 'polaris-checkin')`,
        [main.id, `🔔 ${text}`],
      );
      await app.db.query('update conversations set updated_at = now() where id = $1', [main.id]);
      await app.notifications.create({ kind: 'info', title: 'Polaris', body: text.slice(0, 300), ref: { conversationId: main.id } });
      return { posted: true, text };
    } finally {
      await app.conversations.remove(sub.id).catch(() => undefined);
    }
  }
}
