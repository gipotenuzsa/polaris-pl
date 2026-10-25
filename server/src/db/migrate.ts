import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Db } from './types.js';

/** server/src/db → ../../../supabase/migrations (так же из server/dist/db). */
export function defaultMigrationsDir(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, '..', '..', '..', 'supabase', 'migrations');
}

export async function migrate(db: Db, dir = defaultMigrationsDir()): Promise<string[]> {
  await db.exec(
    'create table if not exists _polaris_migrations (name text primary key, applied_at timestamptz not null default now())',
  );
  const applied = new Set(
    (await db.query<{ name: string }>('select name from _polaris_migrations')).map((r) => r.name),
  );
  const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
  const ran: string[] = [];
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = await readFile(path.join(dir, file), 'utf8');
    await db.transaction(async (tx) => {
      await tx.exec(sql);
      await tx.query('insert into _polaris_migrations (name) values ($1)', [file]);
    });
    ran.push(file);
  }
  return ran;
}
