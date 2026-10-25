import type { AppContext } from '../context.js';
import { queryOne } from '../db/types.js';
import { notFound } from '../util/errors.js';

export type MemoryKind = 'fact' | 'preference';

export interface MemoryRow {
  id: string;
  kind: MemoryKind;
  content: string;
  source: string;
  created_at: Date;
  updated_at: Date;
}

export interface MemoryDto {
  id: string;
  kind: MemoryKind;
  content: string;
  source: string;
  createdAt: string;
  updatedAt: string;
}

export const toMemoryDto = (r: MemoryRow): MemoryDto => ({
  id: r.id,
  kind: r.kind,
  content: r.content,
  source: r.source,
  createdAt: new Date(r.created_at).toISOString(),
  updatedAt: new Date(r.updated_at).toISOString(),
});

const tokenize = (s: string) =>
  new Set(
    s
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter((w) => w.length > 2),
  );

/** Долгосрочная память: факты и предпочтения. Пользователь видит, правит и удаляет всё. */
export class MemoryService {
  constructor(private readonly ctx: AppContext) {}

  async list(kind?: MemoryKind): Promise<MemoryDto[]> {
    const rows = kind
      ? await this.ctx.db.query<MemoryRow>('select * from memory where kind = $1 order by updated_at desc', [kind])
      : await this.ctx.db.query<MemoryRow>('select * from memory order by updated_at desc');
    return rows.map(toMemoryDto);
  }

  async get(id: string): Promise<MemoryRow> {
    const row = await queryOne<MemoryRow>(this.ctx.db, 'select * from memory where id = $1', [id]);
    if (!row) throw notFound('Запись памяти не найдена');
    return row;
  }

  /** Добавляет запись; точный дубликат не создаётся, а только «освежается». */
  async create(input: {
    kind: MemoryKind;
    content: string;
    source?: string;
  }): Promise<{ row: MemoryRow; created: boolean }> {
    const content = input.content.trim();
    const dup = await queryOne<MemoryRow>(
      this.ctx.db,
      'select * from memory where lower(content) = lower($1) and kind = $2',
      [content, input.kind],
    );
    if (dup) {
      await this.ctx.db.query('update memory set updated_at = now() where id = $1', [dup.id]);
      return { row: dup, created: false };
    }
    const rows = await this.ctx.db.query<MemoryRow>(
      'insert into memory (kind, content, source) values ($1, $2, $3) returning *',
      [input.kind, content, input.source ?? 'user'],
    );
    return { row: rows[0]!, created: true };
  }

  async update(id: string, patch: { kind?: MemoryKind; content?: string }): Promise<MemoryRow> {
    const cur = await this.get(id);
    const rows = await this.ctx.db.query<MemoryRow>(
      'update memory set kind = $2, content = $3, updated_at = now() where id = $1 returning *',
      [id, patch.kind ?? cur.kind, patch.content?.trim() ?? cur.content],
    );
    return rows[0]!;
  }

  async remove(id: string): Promise<MemoryRow> {
    const cur = await this.get(id);
    await this.ctx.db.query('delete from memory where id = $1', [id]);
    return cur;
  }

  /** Восстановление удалённой записи (откат). */
  async restore(row: MemoryRow): Promise<void> {
    await this.ctx.db.query(
      `insert into memory (id, kind, content, source, created_at, updated_at) values ($1, $2, $3, $4, $5, $6)
       on conflict (id) do nothing`,
      [row.id, row.kind, row.content, row.source, row.created_at, row.updated_at],
    );
  }

  async search(query: string, limit = 10): Promise<MemoryDto[]> {
    const all = await this.list();
    const q = tokenize(query);
    if (q.size === 0) return all.slice(0, limit);
    return all
      .map((m) => ({ m, score: [...tokenize(m.content)].filter((w) => q.has(w)).length }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((x) => x.m);
  }

  /** Раздел системного промпта: память целиком, если помещается, иначе самое релевантное запросу и свежее. */
  async promptSection(query: string, maxChars = 3500): Promise<string> {
    const all = await this.list();
    if (all.length === 0) return '';
    const line = (m: MemoryDto) =>
      `- [${m.kind === 'fact' ? 'факт' : 'предпочтение'}] ${m.content} (id: ${m.id.slice(0, 8)})`;
    let chosen = all;
    if (all.reduce((n, m) => n + line(m).length + 1, 0) > maxChars) {
      const q = tokenize(query);
      chosen = all
        .map((m, i) => ({ m, score: [...tokenize(m.content)].filter((w) => q.has(w)).length * 10 - i * 0.1 }))
        .sort((a, b) => b.score - a.score)
        .map((x) => x.m);
    }
    const lines: string[] = [];
    let used = 0;
    for (const m of chosen) {
      const l = line(m);
      if (used + l.length + 1 > maxChars) break;
      lines.push(l);
      used += l.length + 1;
    }
    return lines.join('\n');
  }
}
