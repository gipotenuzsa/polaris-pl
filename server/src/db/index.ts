import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import pg from 'pg';
import type { Config } from '../config.js';
import type { Db } from './types.js';

type Queryable = pg.Pool | pg.PoolClient;

class PgDb implements Db {
  constructor(
    private readonly target: Queryable,
    private readonly pool: pg.Pool,
    private readonly inTx = false,
  ) {}

  async query<T>(text: string, params?: unknown[]): Promise<T[]> {
    const res = await this.target.query(text, params as unknown[] | undefined);
    return res.rows as T[];
  }

  async exec(sql: string): Promise<void> {
    await this.target.query(sql);
  }

  async transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T> {
    if (this.inTx) return fn(this);
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      const result = await fn(new PgDb(client, this.pool, true));
      await client.query('commit');
      return result;
    } catch (err) {
      await client.query('rollback').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    if (!this.inTx) await this.pool.end();
  }
}

interface PgliteLike {
  query(text: string, params?: unknown[]): Promise<{ rows: unknown[] }>;
  exec(sql: string): Promise<unknown>;
  transaction<T>(fn: (tx: PgliteLike) => Promise<T>): Promise<T>;
  close?(): Promise<void>;
}

class PgliteDb implements Db {
  constructor(
    private readonly pg: PgliteLike,
    private readonly inTx = false,
  ) {}

  async query<T>(text: string, params?: unknown[]): Promise<T[]> {
    const res = await this.pg.query(text, params);
    return res.rows as T[];
  }

  async exec(sql: string): Promise<void> {
    await this.pg.exec(sql);
  }

  async transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T> {
    if (this.inTx) return fn(this);
    return this.pg.transaction((tx) => fn(new PgliteDb(tx, true)));
  }

  async close(): Promise<void> {
    if (!this.inTx) await this.pg.close?.();
  }
}

/** Подключение к Postgres по DATABASE_URL (Supabase) либо локальный PGlite. */
export async function createDb(
  config: Pick<Config, 'databaseUrl' | 'databaseSsl' | 'dataDir' | 'isProd'>,
): Promise<Db> {
  if (config.databaseUrl) {
    const url = new URL(config.databaseUrl);
    url.searchParams.delete('sslmode');
    const local = ['localhost', '127.0.0.1', '::1'].includes(url.hostname);
    const sslOff = config.databaseSsl === 'false' || (config.databaseSsl === undefined && local);
    const pool = new pg.Pool({
      connectionString: url.toString(),
      ssl: sslOff ? undefined : { rejectUnauthorized: false },
      max: 5,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 15_000,
    });
    pool.on('error', () => undefined); // обрыв простаивающего соединения не должен ронять процесс
    return new PgDb(pool, pool);
  }

  if (config.isProd) {
    throw new Error('DATABASE_URL обязателен в production (строка подключения Supabase Postgres)');
  }

  const { PGlite } = await import('@electric-sql/pglite');
  let instance;
  if (config.dataDir === 'memory://') {
    instance = new PGlite();
  } else {
    const dir = path.resolve(config.dataDir, 'pglite');
    await mkdir(dir, { recursive: true });
    instance = new PGlite(dir);
  }
  await instance.waitReady;
  return new PgliteDb(instance as unknown as PgliteLike);
}

export function createMemoryDb(): Promise<Db> {
  return createDb({ databaseUrl: undefined, databaseSsl: undefined, dataDir: 'memory://', isProd: false });
}

export type { Db } from './types.js';
