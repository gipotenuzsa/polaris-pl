import type { AppContext } from '../context.js';
import { queryOne } from '../db/types.js';
import { notFound } from '../util/errors.js';

interface ProjectRow {
  id: string;
  name: string;
  instructions: string;
  created_at: Date;
  updated_at: Date;
  chat_count?: number | string;
}

export interface ProjectDto {
  id: string;
  name: string;
  instructions: string;
  chatCount: number;
  createdAt: string;
  updatedAt: string;
}

const iso = (d: Date | string) => new Date(d).toISOString();

const toDto = (r: ProjectRow): ProjectDto => ({
  id: r.id,
  name: r.name,
  instructions: r.instructions,
  chatCount: Number(r.chat_count ?? 0),
  createdAt: iso(r.created_at),
  updatedAt: iso(r.updated_at),
});

/** Проекты — папки для чатов с общими инструкциями, которые попадают в системный промпт каждого чата проекта. */
export class ProjectService {
  constructor(private readonly ctx: AppContext) {}

  async list(): Promise<ProjectDto[]> {
    const rows = await this.ctx.db.query<ProjectRow>(
      `select p.*, (select count(*) from conversations c where c.project_id = p.id and c.kind = 'chat') as chat_count
         from projects p order by p.updated_at desc`,
    );
    return rows.map(toDto);
  }

  async get(id: string): Promise<ProjectDto> {
    const row = await queryOne<ProjectRow>(
      this.ctx.db,
      `select p.*, (select count(*) from conversations c where c.project_id = p.id and c.kind = 'chat') as chat_count
         from projects p where p.id = $1`,
      [id],
    );
    if (!row) throw notFound('Проект не найден');
    return toDto(row);
  }

  async create(name: string, instructions = ''): Promise<ProjectDto> {
    const rows = await this.ctx.db.query<ProjectRow>(
      'insert into projects (name, instructions) values ($1, $2) returning *',
      [name.slice(0, 120), instructions.slice(0, 8000)],
    );
    return toDto(rows[0]!);
  }

  async update(id: string, patch: { name?: string; instructions?: string }): Promise<void> {
    await this.get(id);
    if (patch.name !== undefined) {
      await this.ctx.db.query('update projects set name = $2, updated_at = now() where id = $1', [
        id,
        patch.name.slice(0, 120),
      ]);
    }
    if (patch.instructions !== undefined) {
      await this.ctx.db.query('update projects set instructions = $2, updated_at = now() where id = $1', [
        id,
        patch.instructions.slice(0, 8000),
      ]);
    }
  }

  /** Чаты остаются, но выходят из проекта (внешний ключ on delete set null). */
  async remove(id: string): Promise<void> {
    await this.get(id);
    await this.ctx.db.query('delete from projects where id = $1', [id]);
  }

  /** Название и инструкции проекта, к которому относится чат (для системного промпта). */
  async forConversation(conversationId: string): Promise<{ name: string; instructions: string } | null> {
    const row = await queryOne<{ name: string; instructions: string }>(
      this.ctx.db,
      `select p.name, p.instructions from projects p
         join conversations c on c.project_id = p.id where c.id = $1`,
      [conversationId],
    );
    return row ?? null;
  }
}
