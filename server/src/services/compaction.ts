import type { AppContext } from '../context.js';
import { errorMessage } from '../util/errors.js';
import type { MessageRow } from './conversations.js';

/** Когда хвост разговора после сводки занимает больше этой доли окна контекста — старую часть сжимаем. */
const COMPACT_AT = 0.75;
/** Сколько недавних реплик (доля окна) оставляем дословно. */
const KEEP_RECENT = 0.3;
const CHARS_PER_TOKEN = 3.5;
const PER_MESSAGE_CHARS = 1500;
const TRANSCRIPT_CHARS = 48_000;
const SUMMARY_MAX_TOKENS = 1800;

const SYSTEM = `Ты сжимаешь историю длинного разговора личного AI-агента с его владельцем, чтобы агент мог продолжить работу, не перечитывая всё.
Обнови сводку: объедини «предыдущую сводку» и «новые реплики» в одну связную. Сохраняй только то, что пригодится дальше:
- что просил и решал пользователь, договорённости и принятые решения;
- устойчивые факты и предпочтения пользователя;
- результаты работы (имена, числа, даты, ссылки, названия файлов и задач);
- незавершённые дела, обещания и ожидаемые ответы.
Опускай приветствия, повторы, неудачные попытки и пересказ чужих веб-страниц. Пиши по-русски, списками по темам, не длиннее 600 слов. Ответь только текстом сводки.`;

const rowTokens = (r: MessageRow) =>
  Math.ceil((r.content.length + (r.tool_calls ? JSON.stringify(r.tool_calls).length : 0)) / CHARS_PER_TOKEN) + 4;

function transcript(rows: MessageRow[]): string {
  const cap = Math.min(PER_MESSAGE_CHARS, Math.max(200, Math.floor(TRANSCRIPT_CHARS / Math.max(rows.length, 1))));
  const clip = (s: string) => (s.length > cap ? `${s.slice(0, cap)}…` : s);
  const lines: string[] = [];
  for (const r of rows) {
    if (r.role === 'user') lines.push(`Пользователь: ${clip(r.content)}`);
    else if (r.role === 'assistant') {
      const calls = r.tool_calls?.length ? ` [вызвал: ${r.tool_calls.map((c) => c.name).join(', ')}]` : '';
      if (r.content || calls) lines.push(`Polaris: ${clip(r.content)}${calls}`);
    } else if (r.role === 'tool') lines.push(`[результат ${r.tool_name ?? 'инструмента'}]: ${clip(r.content)}`);
  }
  return lines.join('\n');
}

/**
 * Сжатие длинного разговора — по принципу компактификации в Claude Code: старая часть превращается в сводку
 * (хранится в самом разговоре), последние реплики остаются дословно, а подробности из ушедшей части агент достаёт
 * по требованию инструментом history_search. Благодаря этому единый «вечный» чат не раздувает контекст.
 */
export class CompactionService {
  private readonly running = new Set<string>();

  constructor(private readonly ctx: AppContext) {}

  /** Запускает сжатие, если оно нужно. Ошибки не пробрасываются: это фоновая оптимизация. */
  async maybeCompact(conversationId: string): Promise<boolean> {
    if (this.running.has(conversationId)) return false;
    this.running.add(conversationId);
    try {
      return await this.run(conversationId);
    } catch (err) {
      this.ctx.log.warn({ err: errorMessage(err), conversationId }, 'Не удалось сжать разговор');
      return false;
    } finally {
      this.running.delete(conversationId);
    }
  }

  private async run(conversationId: string): Promise<boolean> {
    const app = this.ctx;
    const window = app.config.agent.contextTokens;
    const { summary, upto } = await app.conversations.summaryState(conversationId);
    const rows = await app.conversations.messages(conversationId, upto, 2000);
    const total = rows.reduce((n, r) => n + rowTokens(r), 0);
    if (total <= window * COMPACT_AT) return false;

    // Режем по границе реплики пользователя, чтобы не разорвать пары «вызов инструмента — результат».
    let tail = 0;
    let cut = -1;
    for (let i = rows.length - 1; i > 0; i--) {
      tail += rowTokens(rows[i]!);
      // последняя реплика пользователя остаётся всегда, даже если она одна больше «недавней» доли окна
      if (rows[i]!.role === 'user' && (cut === -1 || tail <= window * KEEP_RECENT)) cut = i;
      if (tail > window * KEEP_RECENT && cut !== -1) break;
    }
    if (cut < 2) return false;
    const old = rows.slice(0, cut);
    if (old.some((r) => r.role === 'tool' && r.status === 'pending')) return false; // ждёт подтверждения — не трогаем

    const text = transcript(old);
    if (!text.trim()) return false;
    await app.budget.assertCanSpend({ conversationId, since: new Date(old[0]!.created_at) });
    const resp = await app.providers.chat({
      messages: [
        { role: 'system', content: SYSTEM },
        {
          role: 'user',
          content: `Предыдущая сводка:\n${summary || '(пока нет)'}\n\nНовые реплики для включения в сводку:\n${text}`,
        },
      ],
      maxTokens: SUMMARY_MAX_TOKENS,
    });
    const next = resp.content.trim();
    if (!next) return false;

    await app.budget.record({ provider: resp.provider, model: resp.model, usage: resp.usage, conversationId });
    await app.conversations.setSummary(conversationId, next, old[old.length - 1]!.seq);
    await app.conversations.add({
      conversationId,
      role: 'system',
      toolName: 'compaction',
      content: `Ранняя часть разговора (${old.length} сообщ.) сжата в сводку`,
    });
    app.log.info({ conversationId, compacted: old.length, summaryChars: next.length }, 'Разговор сжат');
    return true;
  }
}
