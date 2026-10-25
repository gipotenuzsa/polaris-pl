import { redact } from '../crypto/redact.js';
import type { AppContext } from '../context.js';
import { json, queryOne } from '../db/types.js';
import { executeTool } from '../tools/exec.js';
import { conflict, notFound } from '../util/errors.js';

export type ApprovalStatus = 'pending' | 'approved' | 'rejected';

interface ApprovalRow {
  id: string;
  action: string;
  summary: string;
  payload: { args: unknown; toolCallId?: string };
  status: ApprovalStatus;
  task_id: string | null;
  conversation_id: string | null;
  created_at: Date;
  resolved_at: Date | null;
}

export interface ApprovalDto {
  id: string;
  action: string;
  summary: string;
  args: unknown;
  status: ApprovalStatus;
  taskId?: string;
  conversationId?: string;
  createdAt: string;
  resolvedAt?: string;
}

const toDto = (r: ApprovalRow): ApprovalDto => ({
  id: r.id,
  action: r.action,
  summary: r.summary,
  args: redact(r.payload.args),
  status: r.status,
  taskId: r.task_id ?? undefined,
  conversationId: r.conversation_id ?? undefined,
  createdAt: new Date(r.created_at).toISOString(),
  resolvedAt: r.resolved_at ? new Date(r.resolved_at).toISOString() : undefined,
});

export class ApprovalsService {
  constructor(private readonly ctx: AppContext) {}

  async create(input: {
    action: string;
    summary: string;
    args: unknown;
    toolCallId?: string;
    conversationId?: string;
    taskId?: string;
  }): Promise<ApprovalDto> {
    const rows = await this.ctx.db.query<ApprovalRow>(
      `insert into approvals (action, summary, payload, task_id, conversation_id)
       values ($1, $2, $3::jsonb, $4, $5) returning *`,
      [
        input.action,
        input.summary.slice(0, 1000),
        json({ args: input.args, toolCallId: input.toolCallId }),
        input.taskId ?? null,
        input.conversationId ?? null,
      ],
    );
    const dto = toDto(rows[0]!);
    await this.ctx.notifications.create({
      kind: 'approval',
      title: 'Нужно подтверждение',
      body: dto.summary,
      ref: { approvalId: dto.id, taskId: input.taskId, conversationId: input.conversationId },
    });
    return dto;
  }

  async list(status?: ApprovalStatus, limit = 100): Promise<ApprovalDto[]> {
    const rows = status
      ? await this.ctx.db.query<ApprovalRow>(
          'select * from approvals where status = $1 order by created_at desc limit $2',
          [status, limit],
        )
      : await this.ctx.db.query<ApprovalRow>('select * from approvals order by created_at desc limit $1', [limit]);
    return rows.map(toDto);
  }

  async get(id: string): Promise<ApprovalDto> {
    const row = await queryOne<ApprovalRow>(this.ctx.db, 'select * from approvals where id = $1', [id]);
    if (!row) throw notFound('Подтверждение не найдено');
    return toDto(row);
  }

  async pendingCount(): Promise<number> {
    const rows = await this.ctx.db.query<{ n: number }>(
      `select count(*)::int as n from approvals where status = 'pending'`,
    );
    return rows[0]?.n ?? 0;
  }

  /**
   * Решение пользователя. Переход pending → approved/rejected атомарный, поэтому двойной тап
   * не выполнит действие дважды. После решения, если в диалоге не осталось ожидающих вызовов, агент продолжает работу.
   */
  async resolve(id: string, decision: 'approve' | 'reject', note?: string): Promise<ApprovalDto> {
    const app = this.ctx;
    const claimed = await app.db.query<ApprovalRow>(
      `update approvals set status = $2, resolved_at = now() where id = $1 and status = 'pending' returning *`,
      [id, decision === 'approve' ? 'approved' : 'rejected'],
    );
    const row = claimed[0];
    if (!row) {
      const existing = await queryOne<ApprovalRow>(app.db, 'select * from approvals where id = $1', [id]);
      if (!existing) throw notFound('Подтверждение не найдено');
      throw conflict('Решение уже принято');
    }

    const toolCallId = row.payload.toolCallId;
    let content: string;
    let status: 'ok' | 'error' | 'rejected';

    if (decision === 'approve') {
      const tool = app.tools.get(row.action);
      if (!tool) {
        content = `Инструмент ${row.action} больше недоступен.`;
        status = 'error';
      } else {
        const out = await executeTool(app, tool, row.payload.args, {
          conversationId: row.conversation_id ?? undefined,
          taskId: row.task_id ?? undefined,
          approvalId: row.id,
        });
        content = out.content;
        status = out.ok ? 'ok' : 'error';
      }
    } else {
      content = `Пользователь отклонил это действие${note ? `: ${note}` : ''}. Не повторяй его без нового разрешения.`;
      status = 'rejected';
      await app.actions.log({
        tool: row.action,
        args: row.payload.args,
        summary: `Отклонено пользователем: ${row.summary}`,
        status: 'rejected',
        taskId: row.task_id ?? undefined,
        conversationId: row.conversation_id ?? undefined,
        approvalId: row.id,
      });
    }

    if (row.conversation_id && toolCallId) {
      await app.conversations.resolveToolMessage(row.conversation_id, toolCallId, {
        content,
        status: status === 'ok' ? 'ok' : status === 'rejected' ? 'rejected' : 'error',
      });
    }
    if (row.task_id) {
      await app.tasks.addStep(row.task_id, {
        type: 'approval',
        input: { action: row.action, summary: row.summary },
        output: { decision: decision === 'approve' ? 'approved' : 'rejected', result: content.slice(0, 2000) },
        status: decision === 'approve' ? 'ok' : 'rejected',
      });
    }
    await app.notifications.markApprovalRead(row.id);
    await this.resumeIfReady(row);

    return this.get(row.id);
  }

  private async resumeIfReady(row: ApprovalRow): Promise<void> {
    if (!row.conversation_id) return;
    if ((await this.ctx.conversations.pendingToolCount(row.conversation_id)) > 0) return;
    if (row.task_id) await this.ctx.tasks.resumeAfterApproval(row.task_id);
    else this.ctx.runs.startChat(row.conversation_id);
  }

  /** Подтверждения, на которые долго не отвечали, считаются отклонёнными — иначе задача зависнет навсегда. */
  async expireStale(now: Date): Promise<number> {
    const cutoff = new Date(now.getTime() - this.ctx.config.approvalTtlHours * 3_600_000);
    const stale = await this.ctx.db.query<{ id: string }>(
      `select id from approvals where status = 'pending' and created_at < $1`,
      [cutoff],
    );
    for (const s of stale) {
      await this.resolve(s.id, 'reject', 'истёк срок ожидания').catch((err: unknown) =>
        this.ctx.log.warn({ err: String(err) }, 'Не удалось закрыть просроченное подтверждение'),
      );
    }
    return stale.length;
  }
}
