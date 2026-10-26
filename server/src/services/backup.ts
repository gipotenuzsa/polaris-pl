import type { AppContext } from '../context.js';
import type { Db } from '../db/types.js';
import { badRequest } from '../util/errors.js';

/**
 * Резервная копия данных в JSON: переписка, вложения, память, заметки, задачи, настройки и т.д.
 * Нужна для переезда на другую базу (например, с бесплатной базы Render на Supabase) и как страховка.
 * Не попадают: токены ChatGPT и сессии (секреты, привязанные к ключу шифрования), подписки push и ключи VAPID —
 * после переезда нужно заново войти в ChatGPT и включить уведомления.
 */

/** Порядок важен: сначала родители, потом зависимые таблицы. */
const TABLES = [
  { name: 'conversations', order: 'created_at' },
  { name: 'messages', order: 'seq', identity: 'seq' },
  { name: 'attachments', order: 'created_at', batch: 10 },
  { name: 'memory', order: 'created_at' },
  { name: 'notes', order: 'created_at' },
  { name: 'reminders', order: 'created_at' },
  { name: 'tasks', order: 'created_at' },
  { name: 'task_steps', order: 'seq', identity: 'seq' },
  { name: 'approvals', order: 'created_at' },
  { name: 'actions_log', order: 'created_at' },
  { name: 'notifications', order: 'created_at' },
  { name: 'usage_log', order: 'created_at' },
  { name: 'settings', order: 'key' },
] as const;

type TableName = (typeof TABLES)[number]['name'];

export const BACKUP_FORMAT = 'polaris-backup';
/** Эти настройки привязаны к ключу шифрования сервера и в копию не входят. */
const SKIP_SETTINGS = ['webpush'];

export interface BackupFile {
  format: typeof BACKUP_FORMAT;
  version: 1;
  createdAt: string;
  tables: Partial<Record<TableName, Record<string, unknown>[]>>;
}

export class BackupService {
  constructor(private readonly ctx: AppContext) {}

  async export(): Promise<BackupFile> {
    const tables: BackupFile['tables'] = {};
    for (const t of TABLES) {
      const where = t.name === 'settings' ? `where key <> all($1::text[])` : '';
      const rows = await this.ctx.db.query<Record<string, unknown>>(
        `select * from ${t.name} ${where} order by ${t.order}`,
        t.name === 'settings' ? [SKIP_SETTINGS] : [],
      );
      tables[t.name] = rows;
    }
    return { format: BACKUP_FORMAT, version: 1, createdAt: this.ctx.clock().toISOString(), tables };
  }

  /** Заменяет данные этого сервера данными из копии (одной транзакцией). Возвращает число строк по таблицам. */
  async restore(file: unknown): Promise<Record<string, number>> {
    const f = file as Partial<BackupFile> | null;
    if (!f || f.format !== BACKUP_FORMAT || f.version !== 1 || typeof f.tables !== 'object' || f.tables === null) {
      throw badRequest('Это не резервная копия Polaris (ожидался файл, скачанный в разделе «Резервная копия»)');
    }
    const counts: Record<string, number> = {};
    await this.ctx.db.transaction(async (tx: Db) => {
      // Очистка в обратном порядке зависимостей; каскады убирают вложения и шаги.
      for (const t of [...TABLES].reverse()) {
        if (t.name === 'settings') await tx.query(`delete from settings where key <> all($1::text[])`, [SKIP_SETTINGS]);
        else await tx.query(`delete from ${t.name}`);
      }
      for (const t of TABLES) {
        const rows = (f.tables as Record<string, unknown>)[t.name];
        if (rows === undefined) continue;
        if (!Array.isArray(rows)) throw badRequest(`Таблица ${t.name} в копии повреждена`);
        const list = (t.name === 'settings' ? rows.filter((r) => !SKIP_SETTINGS.includes(String((r as { key?: string }).key))) : rows) as unknown[];
        const size = 'batch' in t ? t.batch : 200;
        for (let i = 0; i < list.length; i += size) {
          const chunk = list.slice(i, i + size);
          // jsonb_populate_recordset берёт только известные колонки таблицы — лишние поля из файла игнорируются
          await tx.query(
            `insert into ${t.name} ${'identity' in t ? 'overriding system value' : ''}
             select * from jsonb_populate_recordset(null::${t.name}, $1::jsonb)`,
            [JSON.stringify(chunk)],
          );
        }
        counts[t.name] = list.length;
        if ('identity' in t && list.length > 0) {
          await tx.query(
            `select setval(pg_get_serial_sequence('${t.name}', '${t.identity}'), (select max(${t.identity}) from ${t.name}))`,
          );
        }
      }
    });
    return counts;
  }
}
