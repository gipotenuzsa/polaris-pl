import type { AppContext } from '../context.js';
import { errorMessage } from '../util/errors.js';

export interface TickResult {
  skipped?: boolean;
  remindersFired: number;
  approvalsExpired: number;
  tasksStarted: number;
  morningStarted: boolean;
}

/**
 * Планировщик: встроенный таймер + внешние вызовы /internal/tick (pg_cron).
 * Тики идемпотентны: задачи забираются атомарно, напоминания срабатывают один раз.
 */
export class Scheduler {
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;

  constructor(private readonly ctx: AppContext) {}

  async start(): Promise<void> {
    const { scheduler } = this.ctx.config;
    if (!scheduler.enabled || this.timer) return;
    const recovered = await this.ctx.tasks.recoverStuck();
    if (recovered > 0) this.ctx.log.info({ recovered }, 'Незавершённые задачи возвращены в очередь');
    this.timer = setInterval(() => this.kick(), scheduler.tickSeconds * 1000);
    this.timer.unref();
    this.kick();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Запустить тик «в фоне» (ошибки только логируются). */
  kick(): void {
    void this.tick().catch((err: unknown) => this.ctx.log.error({ err: errorMessage(err) }, 'Сбой тика планировщика'));
  }

  async tick(): Promise<TickResult> {
    const empty: TickResult = { remindersFired: 0, approvalsExpired: 0, tasksStarted: 0, morningStarted: false };
    if (this.ticking) return { ...empty, skipped: true };
    this.ticking = true;
    try {
      const app = this.ctx;
      const now = app.clock();
      const remindersFired = await app.reminders.fireDue(now);
      const approvalsExpired = await app.approvals.expireStale(now);
      const morningStarted = await app.morning.maybeRun(now);
      const free = app.config.scheduler.maxConcurrentRuns - app.runs.activeCount();
      const due = await app.tasks.claimDue(now, free);
      for (const task of due) app.tasks.start(task);
      return { remindersFired, approvalsExpired, tasksStarted: due.length, morningStarted };
    } finally {
      this.ticking = false;
    }
  }
}
