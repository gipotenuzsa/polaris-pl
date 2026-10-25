import { redact, redactString } from '../crypto/redact.js';
import type { AppContext } from '../context.js';
import { json, queryOne } from '../db/types.js';
import { undoers } from '../tools/undo.js';
import type { UndoInfo } from '../tools/types.js';
import { badRequest, conflict, errorMessage, notFound } from '../util/errors.js';

export type ActionStatus = 'ok' | 'error' | 'rejected';

interface ActionRow {
  id: string;
  tool: string;
  args: Record<string, unknown>;
  result_summary: string;
  status: ActionStatus;
  undo: UndoInfo | null;
  undone_at: Date | null;
  task_id: string | null;
  conversation_id: string | null;
  approval_id: string | null;
  created_at: Date;
}

export interface ActionDto {
  id: string;
  tool: string;
  args: Record<string, unknown>;
  summary: string;
  status: ActionStatus;
  undoable: boolean;
  undone: boolean;
  taskId?: string;
  conversationId?: string;
  approvalId?: string;
  createdAt: string;
}

const toDto = (r: ActionRow): ActionDto => ({
  id: r.id,
  tool: r.tool,
  args: r.args,
  summary: r.result_summary,
  status: r.status,
  undoable: r.status === 'ok' && r.undo !== null && r.undone_at === null,
  undone: r.undone_at !== null,
  taskId: r.task_id ?? undefined,
  conversationId: r.conversation_id ?? undefined,
  approvalId: r.approval_id ?? undefined,
  createdAt: new Date(r.created_at).toISOString(),
});

export interface LogEntry {
  tool: string;
  args: unknown;
  summary: string;
  status: ActionStatus;
  undo?: UndoInfo;
  taskId?: string;
  conversationId?: string;
  approvalId?: string;
}

/** Журнал действий: каждый вызов инструмента. Аргументы и сводка проходят очистку от секретов. */
export class ActionsService {
  constructor(private readonly ctx: AppContext) {}

  async log(e: LogEntry): Promise<string> {
    const safeArgs = redact(e.args);
    const rows = await this.ctx.db.query<{ id: string }>(
      `insert into actions_log (tool, args, result_summary, status, undo, task_id, conversation_id, approval_id)
       values ($1, $2::jsonb, $3, $4, $5::jsonb, $6, $7, $8) returning id`,
      [
        e.tool,
        json(safeArgs && typeof safeArgs === 'object' ? safeArgs : { value: safeArgs }),
        redactString(e.summary).slice(0, 1000),
        e.status,
        json(e.undo),
        e.taskId ?? null,
        e.conversationId ?? null,
        e.approvalId ?? null,
      ],
    );
    return rows[0]!.id;
  }

  async list(opts: { limit?: number; tool?: string } = {}): Promise<ActionDto[]> {
    const rows = opts.tool
      ? await this.ctx.db.query<ActionRow>(
          'select * from actions_log where tool = $1 order by created_at desc limit $2',
          [opts.tool, opts.limit ?? 100],
        )
      : await this.ctx.db.query<ActionRow>('select * from actions_log order by created_at desc limit $1', [
          opts.limit ?? 100,
        ]);
    return rows.map(toDto);
  }

  async undo(id: string): Promise<{ message: string }> {
    const row = await queryOne<ActionRow>(this.ctx.db, 'select * from actions_log where id = $1', [id]);
    if (!row) throw notFound('Запись журнала не найдена');
    if (row.undone_at) throw conflict('Это действие уже отменено');
    if (!row.undo || row.status !== 'ok') throw badRequest('Для этого действия откат невозможен');
    const undoer = undoers[row.undo.kind];
    if (!undoer) throw badRequest(`Нет обработчика отката «${row.undo.kind}»`);
    let message: string;
    try {
      message = await undoer(this.ctx, row.undo.data);
    } catch (err) {
      throw badRequest(`Откат не удался: ${errorMessage(err)}`);
    }
    await this.ctx.db.query('update actions_log set undone_at = now() where id = $1', [id]);
    await this.log({ tool: `undo:${row.tool}`, args: { actionId: id }, summary: message, status: 'ok' });
    return { message };
  }
}
