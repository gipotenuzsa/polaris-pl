import type { AppContext } from '../context.js';
import { queryOne } from '../db/types.js';
import { zonedTimeToUtc } from '../util/time.js';

const TABLES = new Set(['memory', 'notes', 'reminders', 'tasks']);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Модель видит id в сокращённом виде (первые 8 символов) — разворачиваем в полный. */
export async function resolveId(app: AppContext, table: string, idOrPrefix: string): Promise<string> {
  if (!TABLES.has(table)) throw new Error(`Неизвестная таблица ${table}`);
  const value = idOrPrefix.trim().toLowerCase();
  if (UUID_RE.test(value)) return value;
  if (!/^[0-9a-f-]{4,36}$/.test(value)) throw new Error(`Некорректный id: ${idOrPrefix}`);
  const rows = await app.db.query<{ id: string }>(`select id from ${table} where id::text like $1 limit 2`, [
    `${value}%`,
  ]);
  if (rows.length === 0) throw new Error(`Запись с id ${idOrPrefix} не найдена`);
  if (rows.length > 1) throw new Error(`Префикс id ${idOrPrefix} неоднозначен — укажите больше символов`);
  return rows[0]!.id;
}

/** ISO-дата; без указания пояса трактуется в часовом поясе инстанса. */
export function parseDateTime(input: string, tz: string): Date {
  const text = input.trim();
  const hasZone = /(Z|[+-]\d{2}:?\d{2})$/i.test(text);
  if (hasZone) {
    const d = new Date(text);
    if (Number.isNaN(d.getTime())) throw new Error(`Не удалось разобрать дату: ${input}`);
    return d;
  }
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::\d{2})?)?$/.exec(text);
  if (!m) throw new Error(`Ожидается дата в формате ISO 8601, например 2026-03-01T09:30: ${input}`);
  return zonedTimeToUtc(Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4] ?? 0), Number(m[5] ?? 0), tz);
}

export async function rowExists(app: AppContext, table: string, id: string): Promise<boolean> {
  if (!TABLES.has(table)) throw new Error(`Неизвестная таблица ${table}`);
  return (await queryOne(app.db, `select 1 as x from ${table} where id = $1`, [id])) !== undefined;
}

export function shortId(id: string): string {
  return id.slice(0, 8);
}
