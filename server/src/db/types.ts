export type Row = Record<string, unknown>;

/** Общий интерфейс над pg (Supabase Postgres) и PGlite (локальная разработка и тесты). */
export interface Db {
  query<T = Row>(text: string, params?: unknown[]): Promise<T[]>;
  /** Несколько SQL-команд без параметров (миграции). */
  exec(sql: string): Promise<void>;
  transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export async function queryOne<T = Row>(db: Db, text: string, params?: unknown[]): Promise<T | undefined> {
  const rows = await db.query<T>(text, params);
  return rows[0];
}

/** jsonb-параметр: массивы и объекты передаём строкой, чтобы pg не превратил массив в PG-массив. */
export function json(value: unknown): string | null {
  return value === undefined || value === null ? null : JSON.stringify(value);
}
