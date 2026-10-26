import { buildSystemPrompt } from '../agent/prompt.js';
import { runAgent } from '../agent/runner.js';
import type { AppContext } from '../context.js';
import { dayKey, parseHHMM, zonedParts, zonedTimeToUtc } from '../util/time.js';

/** Утренняя сводка: раз в сутки в настроенное время агент собирает данные и пишет дайджест в отдельный чат. */
export class MorningService {
  constructor(private readonly ctx: AppContext) {}

  /** Вызывается планировщиком каждый тик. Возвращает true, если сводка запущена. */
  async maybeRun(now: Date): Promise<boolean> {
    const s = await this.ctx.settings.getMorning();
    if (!s.enabled) return false;
    const key = dayKey(now, s.timezone);
    if (s.lastRunDate === key) return false;
    const t = parseHHMM(s.time);
    if (!t) return false;
    const p = zonedParts(now, s.timezone);
    const due = zonedTimeToUtc(p.year, p.month, p.day, t.hour, t.minute, s.timezone);
    if (now.getTime() < due.getTime()) return false;

    await this.ctx.settings.set('morning', { ...s, lastRunDate: key });
    void this.generate().catch((err: unknown) =>
      this.ctx.log.error({ err: String(err) }, 'Утренняя сводка не удалась'),
    );
    return true;
  }

  async gatherData(now: Date): Promise<string> {
    const { db, config } = this.ctx;
    const tz = config.timezone;
    const lines: string[] = [];

    const active = await db.query<{ goal: string; status: string }>(
      `select goal, status from tasks where status in ('scheduled', 'in_progress', 'awaiting_approval') order by created_at desc limit 15`,
    );
    lines.push(`Активные задачи (${active.length}):`);
    for (const t of active) lines.push(`- [${t.status}] ${t.goal.slice(0, 120)}`);

    const done = await db.query<{ goal: string; last_result: string | null; status: string }>(
      `select goal, last_result, status from tasks
        where updated_at > $1 and status in ('done', 'failed') order by updated_at desc limit 10`,
      [new Date(now.getTime() - 24 * 3_600_000)],
    );
    lines.push(`\nЗавершено за сутки (${done.length}):`);
    for (const t of done) lines.push(`- [${t.status}] ${t.goal.slice(0, 80)} → ${(t.last_result ?? '').slice(0, 200)}`);

    const reminders = await db.query<{ text: string; due_at: Date }>(
      `select text, due_at from reminders where status = 'pending' and due_at < $1 order by due_at asc limit 15`,
      [new Date(now.getTime() + 36 * 3_600_000)],
    );
    lines.push(`\nБлижайшие напоминания (${reminders.length}):`);
    for (const r of reminders) {
      const when = new Intl.DateTimeFormat('ru-RU', { timeZone: tz, dateStyle: 'short', timeStyle: 'short' }).format(
        new Date(r.due_at),
      );
      lines.push(`- ${when}: ${r.text}`);
    }

    const approvals = await this.ctx.approvals.pendingCount();
    if (approvals > 0) lines.push(`\nЖдут подтверждения: ${approvals}`);
    return lines.join('\n');
  }

  /** Создаёт сводку немедленно (по расписанию или кнопкой «Сформировать сейчас»). */
  async generate(): Promise<{ conversationId: string }> {
    const app = this.ctx;
    const now = app.clock();
    const s = await app.settings.getMorning();
    const conv = await app.conversations.create(`Сводка ${dayKey(now, s.timezone)}`, 'summary');
    await app.conversations.add({
      conversationId: conv.id,
      role: 'user',
      content: `Составь утреннюю сводку.\n\nДанные:\n${await this.gatherData(now)}`,
    });
    const system = await buildSystemPrompt(app, { mode: 'morning', query: 'новости интересы предпочтения' });
    const run = app.runs.start(conv.id, async () => {
      const outcome = await runAgent(app, {
        conversationId: conv.id,
        system,
        since: now,
        maxSteps: 6,
        toolFilter: (t) => ['read_url', 'memory_search', 'note_list', 'get_time'].includes(t.name),
      });
      if (outcome.status === 'done') {
        // Сводка приходит в единый разговор, как сообщение от Polaris; отдельный чат остаётся в архиве.
        await app.conversations.postToMain(`☀️ **Утренняя сводка**\n\n${outcome.text}`);
        await app.notifications.create({
          kind: 'morning',
          title: 'Утренняя сводка',
          body: outcome.text.slice(0, 1500),
          ref: { conversationId: (await app.conversations.main()).id },
        });
      }
      return outcome;
    });
    void run?.catch(() => undefined);
    return { conversationId: conv.id };
  }
}
