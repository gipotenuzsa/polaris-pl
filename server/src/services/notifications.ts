import type { AppContext } from '../context.js';
import { json } from '../db/types.js';
import { urlForNotification } from './push.js';

export type NotificationKind = 'reminder' | 'task_done' | 'task_failed' | 'approval' | 'morning' | 'info';

interface NotificationRow {
  id: string;
  kind: NotificationKind;
  title: string;
  body: string;
  ref: Record<string, unknown> | null;
  read_at: Date | null;
  created_at: Date;
}

export interface NotificationDto {
  id: string;
  kind: NotificationKind;
  title: string;
  body: string;
  ref?: Record<string, unknown>;
  read: boolean;
  createdAt: string;
}

const toDto = (r: NotificationRow): NotificationDto => ({
  id: r.id,
  kind: r.kind,
  title: r.title,
  body: r.body,
  ref: r.ref ?? undefined,
  read: r.read_at !== null,
  createdAt: new Date(r.created_at).toISOString(),
});

/** Входящие уведомления. Клиент опрашивает их и показывает локально (push на sideload-сборках iOS недоступен). */
export class NotificationsService {
  constructor(private readonly ctx: AppContext) {}

  async create(n: {
    kind: NotificationKind;
    title: string;
    body?: string;
    ref?: Record<string, unknown>;
  }): Promise<NotificationDto> {
    const rows = await this.ctx.db.query<NotificationRow>(
      'insert into notifications (kind, title, body, ref) values ($1, $2, $3, $4::jsonb) returning *',
      [n.kind, n.title.slice(0, 200), (n.body ?? '').slice(0, 4000), json(n.ref)],
    );
    const dto = toDto(rows[0]!);
    // То же событие уходит на телефон как Web Push (если устройство подписано)
    this.ctx.push.notify({
      title: dto.title,
      body: dto.body,
      url: urlForNotification(dto.kind, dto.ref as { conversationId?: string; taskId?: string } | undefined),
      tag: dto.id,
      urgent: dto.kind === 'approval' || dto.kind === 'reminder',
    });
    return dto;
  }

  async list(opts: { unreadOnly?: boolean; limit?: number } = {}): Promise<NotificationDto[]> {
    const rows = await this.ctx.db.query<NotificationRow>(
      `select * from notifications ${opts.unreadOnly ? 'where read_at is null' : ''} order by created_at desc limit $1`,
      [opts.limit ?? 100],
    );
    return rows.map(toDto);
  }

  async unreadCount(): Promise<number> {
    const rows = await this.ctx.db.query<{ n: number }>(
      'select count(*)::int as n from notifications where read_at is null',
    );
    return rows[0]?.n ?? 0;
  }

  async markRead(id: string): Promise<void> {
    await this.ctx.db.query('update notifications set read_at = now() where id = $1 and read_at is null', [id]);
  }

  async markAllRead(): Promise<void> {
    await this.ctx.db.query('update notifications set read_at = now() where read_at is null');
  }

  /** Помечает прочитанными уведомления, связанные с подтверждением (после решения). */
  async markApprovalRead(approvalId: string): Promise<void> {
    await this.ctx.db.query(
      `update notifications set read_at = now() where read_at is null and kind = 'approval' and ref->>'approvalId' = $1`,
      [approvalId],
    );
  }
}
