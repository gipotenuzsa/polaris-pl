import { buildSystemPrompt } from '../agent/prompt.js';
import { runAgent, type RunHooks, type RunOutcome } from '../agent/runner.js';
import type { AppContext } from '../context.js';
import { redact } from '../crypto/redact.js';
import { json, queryOne } from '../db/types.js';
import { badRequest, conflict, errorMessage, notFound } from '../util/errors.js';
import { firstRun, nextRun, type Schedule } from '../util/time.js';

export type TaskStatus = 'scheduled' | 'in_progress' | 'awaiting_approval' | 'done' | 'failed' | 'cancelled';

export interface TaskBudget {
  maxTokens?: number;
  maxUsd?: number;
}

interface TaskRow {
  id: string;
  goal: string;
  status: TaskStatus;
  schedule: Schedule | null;
  next_run_at: Date | null;
  budget: TaskBudget | null;
  run_count: number;
  run_open: boolean;
  conversation_id: string | null;
  last_result: string | null;
  last_error: string | null;
  created_at: Date;
  updated_at: Date;
}

interface StepRow {
  id: string;
  seq: number;
  task_id: string;
  run_no: number;
  type: string;
  input: unknown;
  output: unknown;
  status: string;
  created_at: Date;
}

export interface TaskDto {
  id: string;
  goal: string;
  status: TaskStatus;
  schedule: Schedule | null;
  nextRunAt?: string;
  budget: TaskBudget | null;
  runCount: number;
  conversationId?: string;
  lastResult?: string;
  lastError?: string;
  createdAt: string;
  updatedAt: string;
}

export interface TaskStepDto {
  id: string;
  seq: number;
  runNo: number;
  type: string;
  input: unknown;
  output: unknown;
  status: string;
  createdAt: string;
}

const toDto = (r: TaskRow): TaskDto => ({
  id: r.id,
  goal: r.goal,
  status: r.status,
  schedule: r.schedule,
  nextRunAt: r.next_run_at ? new Date(r.next_run_at).toISOString() : undefined,
  budget: r.budget,
  runCount: r.run_count,
  conversationId: r.conversation_id ?? undefined,
  lastResult: r.last_result ?? undefined,
  lastError: r.last_error ?? undefined,
  createdAt: new Date(r.created_at).toISOString(),
  updatedAt: new Date(r.updated_at).toISOString(),
});

const toStepDto = (r: StepRow): TaskStepDto => ({
  id: r.id,
  seq: r.seq,
  runNo: r.run_no,
  type: r.type,
  input: r.input,
  output: r.output,
  status: r.status,
  createdAt: new Date(r.created_at).toISOString(),
});

export class TaskService {
  private readonly controllers = new Map<string, AbortController>();

  constructor(private readonly ctx: AppContext) {}

  async create(input: { goal: string; schedule?: Schedule | null; budget?: TaskBudget | null }): Promise<TaskDto> {
    const goal = input.goal.trim();
    if (goal.length < 3) throw badRequest('Цель задачи слишком короткая');
    let nextAt: Date;
    try {
      nextAt = firstRun(input.schedule, this.ctx.clock(), this.ctx.config.timezone);
    } catch (err) {
      throw badRequest(errorMessage(err));
    }
    const rows = await this.ctx.db.query<TaskRow>(
      `insert into tasks (goal, status, schedule, next_run_at, budget)
       values ($1, 'scheduled', $2::jsonb, $3, $4::jsonb) returning *`,
      [goal, json(input.schedule ?? null), nextAt, json(input.budget ?? null)],
    );
    const dto = toDto(rows[0]!);
    // Задача «сразу» стартует без ожидания очередного тика.
    if (nextAt.getTime() <= this.ctx.clock().getTime()) this.ctx.scheduler.kick();
    return dto;
  }

  async list(): Promise<TaskDto[]> {
    const rows = await this.ctx.db.query<TaskRow>('select * from tasks order by created_at desc limit 200');
    return rows.map(toDto);
  }

  private async row(id: string): Promise<TaskRow> {
    const r = await queryOne<TaskRow>(this.ctx.db, 'select * from tasks where id = $1', [id]);
    if (!r) throw notFound('Задача не найдена');
    return r;
  }

  async get(id: string): Promise<TaskDto> {
    return toDto(await this.row(id));
  }

  async detail(id: string): Promise<{ task: TaskDto; steps: TaskStepDto[] }> {
    const task = await this.get(id);
    const steps = await this.ctx.db.query<StepRow>(
      'select * from task_steps where task_id = $1 order by seq asc limit 500',
      [id],
    );
    return { task, steps: steps.map(toStepDto) };
  }

  async cancel(id: string): Promise<TaskDto> {
    const cur = await this.row(id);
    if (cur.status === 'cancelled') return toDto(cur);
    await this.ctx.db.query(
      `update tasks set status = 'cancelled', next_run_at = null, run_open = false, updated_at = now() where id = $1`,
      [id],
    );
    this.controllers.get(id)?.abort();
    const pending = await this.ctx.db.query<{ id: string }>(
      `update approvals set status = 'rejected', resolved_at = now() where task_id = $1 and status = 'pending' returning id`,
      [id],
    );
    for (const p of pending) await this.ctx.notifications.markApprovalRead(p.id);
    return this.get(id);
  }

  async remove(id: string): Promise<void> {
    await this.row(id);
    this.controllers.get(id)?.abort();
    await this.ctx.db.query('delete from tasks where id = $1', [id]);
  }

  /** «Запустить сейчас». */
  async runNow(id: string): Promise<TaskDto> {
    const cur = await this.row(id);
    if (cur.status === 'in_progress') throw conflict('Задача уже выполняется');
    if (cur.status === 'awaiting_approval') throw conflict('Задача ждёт подтверждения');
    await this.ctx.db.query(
      `update tasks set status = 'scheduled', next_run_at = $2, updated_at = now() where id = $1`,
      [id, this.ctx.clock()],
    );
    this.ctx.scheduler.kick();
    return this.get(id);
  }

  async addStep(
    taskId: string,
    step: { type: string; input?: unknown; output?: unknown; status?: string },
  ): Promise<void> {
    await this.ctx.db.query(
      `insert into task_steps (task_id, run_no, type, input, output, status)
       values ($1, coalesce((select run_count from tasks where id = $1), 1), $2, $3::jsonb, $4::jsonb, $5)`,
      [taskId, step.type, json(redact(step.input)), json(redact(step.output)), step.status ?? 'ok'],
    );
  }

  /** Атомарно забирает наступившие задачи. */
  async claimDue(now: Date, limit: number): Promise<TaskRow[]> {
    if (limit <= 0) return [];
    return this.ctx.db.query<TaskRow>(
      `update tasks set status = 'in_progress', updated_at = now()
        where id in (
          select id from tasks where status = 'scheduled' and next_run_at <= $1
           order by next_run_at asc limit $2 for update skip locked
        ) returning *`,
      [now, limit],
    );
  }

  /** После перезапуска «в процессе» без живого прогона → снова в очередь (прогон продолжится с места остановки). */
  async recoverStuck(): Promise<number> {
    const rows = await this.ctx.db.query<{ id: string }>(
      `update tasks set status = 'scheduled', next_run_at = $1, updated_at = now()
        where status = 'in_progress' returning id`,
      [this.ctx.clock()],
    );
    return rows.length;
  }

  async resumeAfterApproval(taskId: string): Promise<void> {
    const rows = await this.ctx.db.query<{ id: string }>(
      `update tasks set status = 'scheduled', next_run_at = $2, updated_at = now()
        where id = $1 and status = 'awaiting_approval' returning id`,
      [taskId, this.ctx.clock()],
    );
    if (rows.length > 0) this.ctx.scheduler.kick();
  }

  /** Запускает прогон взятой задачи в фоне. */
  start(task: TaskRow): void {
    void this.execute(task).catch(async (err: unknown) => {
      this.ctx.log.error({ err: errorMessage(err), taskId: task.id }, 'Сбой прогона задачи');
      await this.finish(task, { status: 'failed', error: errorMessage(err) }).catch(() => undefined);
    });
  }

  async execute(task: TaskRow): Promise<RunOutcome> {
    const app = this.ctx;
    let conversationId = task.conversation_id;

    if (!task.run_open || !conversationId) {
      const runNo = task.run_count + 1;
      const conv = await app.conversations.create(`Задача: ${task.goal.slice(0, 80)}`, 'task');
      conversationId = conv.id;
      await app.db.query(
        `update tasks set run_count = $2, run_open = true, conversation_id = $3, last_error = null, updated_at = now() where id = $1`,
        [task.id, runNo, conversationId],
      );
      const prev = task.last_result
        ? `\n\nРезультат прошлого запуска (для контекста):\n${task.last_result.slice(0, 1500)}`
        : '';
      await app.conversations.add({
        conversationId,
        role: 'user',
        content: `Цель фоновой задачи:\n${task.goal}${prev}`,
      });
      await this.addStep(task.id, { type: 'info', output: { message: `Запуск №${runNo}` } });
    }

    const controller = new AbortController();
    this.controllers.set(task.id, controller);
    const convId = conversationId;

    const job = async (): Promise<RunOutcome> => {
      const conv = await app.conversations.get(convId);
      const system = await buildSystemPrompt(app, { mode: 'task', query: task.goal });
      const hooks: RunHooks = {
        onModel: (r) =>
          app.tasks.addStep(task.id, {
            type: 'model',
            input: { provider: r.provider, model: r.model },
            output: { text: r.content.slice(0, 2000), toolCalls: r.toolCalls.map((c) => c.name) },
          }),
        onToolDone: (call, res) =>
          app.tasks.addStep(task.id, {
            type: 'tool',
            input: { tool: call.name, args: call.arguments },
            output: { result: res.content.slice(0, 2000) },
            status: res.ok ? 'ok' : 'error',
          }),
        onApproval: (call, approvalId, summary) =>
          app.tasks.addStep(task.id, {
            type: 'approval',
            input: { tool: call.name, args: call.arguments, approvalId },
            output: { summary },
            status: 'pending',
          }),
      };
      const outcome = await runAgent(app, {
        conversationId: convId,
        taskId: task.id,
        system,
        since: new Date(conv.createdAt),
        budget: task.budget ?? undefined,
        signal: controller.signal,
        hooks,
        toolFilter: (t) => t.name !== 'task_create', // задачи не плодят задачи
      });
      await this.finish(task, outcome);
      return outcome;
    };

    const run = app.runs.start(convId, () => job().finally(() => this.controllers.delete(task.id)));
    return run ?? { status: 'failed', error: 'Прогон уже идёт' };
  }

  private async finish(task: TaskRow, outcome: RunOutcome): Promise<void> {
    const app = this.ctx;
    const fresh = await queryOne<TaskRow>(app.db, 'select * from tasks where id = $1', [task.id]);
    if (!fresh || fresh.status === 'cancelled') return; // отменена или удалена во время прогона

    const ref = { taskId: task.id, conversationId: fresh.conversation_id ?? undefined };
    const title = task.goal.slice(0, 80);

    if (outcome.status === 'awaiting_approval') {
      await app.db.query(`update tasks set status = 'awaiting_approval', updated_at = now() where id = $1`, [task.id]);
      return;
    }

    const next = nextRun(fresh.schedule, app.clock(), app.config.timezone);
    const settle = async (extra: string, params: unknown[]) => {
      await app.db.query(
        `update tasks set status = $2, next_run_at = $3, run_open = false, updated_at = now()${extra} where id = $1`,
        [task.id, next ? 'scheduled' : outcome.status === 'done' ? 'done' : 'failed', next, ...params],
      );
    };

    if (outcome.status === 'done') {
      await settle(', last_result = $4, last_error = null', [outcome.text]);
      await this.addStep(task.id, { type: 'result', output: { text: outcome.text.slice(0, 4000) } });
      await app.conversations.postToMain(`✅ **Готово: ${title}**\n\n${outcome.text}`).catch(() => undefined);
      await app.notifications.create({
        kind: 'task_done',
        title: `Готово: ${title}`,
        body: outcome.text.slice(0, 1500),
        ref,
      });
      return;
    }

    const error = outcome.status === 'failed' ? outcome.error : outcome.message;
    await settle(', last_error = $4', [error]);
    await this.addStep(task.id, { type: 'error', output: { error }, status: 'error' });
    await app.conversations.postToMain(`⚠️ **Не выполнено: ${title}**\n\n${error}`).catch(() => undefined);
    await app.notifications.create({
      kind: 'task_failed',
      title: `Не выполнено: ${title}`,
      body: error.slice(0, 1500),
      ref,
    });
  }
}
