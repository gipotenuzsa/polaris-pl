import type { AppContext } from '../context.js';
import { queryOne } from '../db/types.js';
import { notFound } from '../util/errors.js';

export interface NoteRow {
  id: string;
  title: string;
  body: string;
  created_at: Date;
  updated_at: Date;
}

export interface NoteDto {
  id: string;
  title: string;
  body: string;
  createdAt: string;
  updatedAt: string;
}

export const toNoteDto = (r: NoteRow): NoteDto => ({
  id: r.id,
  title: r.title,
  body: r.body,
  createdAt: new Date(r.created_at).toISOString(),
  updatedAt: new Date(r.updated_at).toISOString(),
});

export class NotesService {
  constructor(private readonly ctx: AppContext) {}

  async list(query?: string, limit = 100): Promise<NoteRow[]> {
    if (query?.trim()) {
      const like = `%${query.trim().replace(/[%_\\]/g, '\\$&')}%`;
      return this.ctx.db.query<NoteRow>(
        'select * from notes where title ilike $1 or body ilike $1 order by updated_at desc limit $2',
        [like, limit],
      );
    }
    return this.ctx.db.query<NoteRow>('select * from notes order by updated_at desc limit $1', [limit]);
  }

  async get(id: string): Promise<NoteRow> {
    const row = await queryOne<NoteRow>(this.ctx.db, 'select * from notes where id = $1', [id]);
    if (!row) throw notFound('Заметка не найдена');
    return row;
  }

  async create(title: string, body = ''): Promise<NoteRow> {
    const rows = await this.ctx.db.query<NoteRow>('insert into notes (title, body) values ($1, $2) returning *', [
      title.trim().slice(0, 200),
      body,
    ]);
    return rows[0]!;
  }

  async update(id: string, patch: { title?: string; body?: string }): Promise<NoteRow> {
    const cur = await this.get(id);
    const rows = await this.ctx.db.query<NoteRow>(
      'update notes set title = $2, body = $3, updated_at = now() where id = $1 returning *',
      [id, (patch.title ?? cur.title).trim().slice(0, 200), patch.body ?? cur.body],
    );
    return rows[0]!;
  }

  async remove(id: string): Promise<NoteRow> {
    const cur = await this.get(id);
    await this.ctx.db.query('delete from notes where id = $1', [id]);
    return cur;
  }

  async restore(row: NoteRow): Promise<void> {
    await this.ctx.db.query(
      `insert into notes (id, title, body, created_at, updated_at) values ($1, $2, $3, $4, $5)
       on conflict (id) do nothing`,
      [row.id, row.title, row.body, row.created_at, row.updated_at],
    );
  }
}

export interface ReminderRow {
  id: string;
  text: string;
  due_at: Date;
  status: 'pending' | 'fired' | 'cancelled';
  created_at: Date;
  fired_at: Date | null;
}

export interface ReminderDto {
  id: string;
  text: string;
  dueAt: string;
  status: ReminderRow['status'];
  createdAt: string;
}

export const toReminderDto = (r: ReminderRow): ReminderDto => ({
  id: r.id,
  text: r.text,
  dueAt: new Date(r.due_at).toISOString(),
  status: r.status,
  createdAt: new Date(r.created_at).toISOString(),
});

export class RemindersService {
  constructor(private readonly ctx: AppContext) {}

  async list(status?: ReminderRow['status']): Promise<ReminderRow[]> {
    return status
      ? this.ctx.db.query<ReminderRow>('select * from reminders where status = $1 order by due_at asc limit 200', [
          status,
        ])
      : this.ctx.db.query<ReminderRow>('select * from reminders order by due_at desc limit 200');
  }

  async create(text: string, dueAt: Date): Promise<ReminderRow> {
    const rows = await this.ctx.db.query<ReminderRow>(
      'insert into reminders (text, due_at) values ($1, $2) returning *',
      [text.trim().slice(0, 500), dueAt],
    );
    return rows[0]!;
  }

  async get(id: string): Promise<ReminderRow> {
    const row = await queryOne<ReminderRow>(this.ctx.db, 'select * from reminders where id = $1', [id]);
    if (!row) throw notFound('Напоминание не найдено');
    return row;
  }

  async cancel(id: string): Promise<ReminderRow> {
    const cur = await this.get(id);
    await this.ctx.db.query(`update reminders set status = 'cancelled' where id = $1 and status = 'pending'`, [id]);
    return cur;
  }

  async reactivate(id: string): Promise<void> {
    await this.ctx.db.query(`update reminders set status = 'pending', fired_at = null where id = $1`, [id]);
  }

  async remove(id: string): Promise<void> {
    await this.ctx.db.query('delete from reminders where id = $1', [id]);
  }

  /** Переводит наступившие напоминания в «сработало» и создаёт уведомления. Возвращает число сработавших. */
  async fireDue(now: Date): Promise<number> {
    const due = await this.ctx.db.query<ReminderRow>(
      `update reminders set status = 'fired', fired_at = now()
        where status = 'pending' and due_at <= $1 returning *`,
      [now],
    );
    for (const r of due) {
      await this.ctx.notifications.create({
        kind: 'reminder',
        title: 'Напоминание',
        body: r.text,
        ref: { reminderId: r.id },
      });
    }
    return due.length;
  }
}
