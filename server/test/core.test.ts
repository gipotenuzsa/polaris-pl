import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { redact, redactString } from '../src/crypto/redact.js';
import { decryptSecret, encryptSecret } from '../src/crypto/secrets.js';
import { createTestDb } from './helpers.js';
import { migrate } from '../src/db/migrate.js';
import { normalizePath, normalizeUserPath } from '../src/storage/types.js';
import { dayKey, firstRun, nextDailyRun, nextRun, startOfDay, zonedParts } from '../src/util/time.js';

describe('config', () => {
  it('ChatGPT OAuth всегда последний в порядке провайдеров', () => {
    const c = loadConfig({ NODE_ENV: 'test', PROVIDER_ORDER: 'chatgpt,gemini,openrouter' });
    expect(c.providers.order).toEqual(['gemini', 'openrouter']);
  });

  it('требует ENCRYPTION_KEY в production', () => {
    expect(() => loadConfig({ NODE_ENV: 'production' })).toThrow(/ENCRYPTION_KEY/);
  });

  it('принимает ключ в base64 и hex', () => {
    const key = Buffer.alloc(32, 7);
    expect(loadConfig({ NODE_ENV: 'test', ENCRYPTION_KEY: key.toString('base64') }).encryptionKey.equals(key)).toBe(
      true,
    );
    expect(loadConfig({ NODE_ENV: 'test', ENCRYPTION_KEY: key.toString('hex') }).encryptionKey.equals(key)).toBe(true);
    expect(() => loadConfig({ NODE_ENV: 'test', ENCRYPTION_KEY: 'short' })).toThrow();
  });

  it('в production открытый пароль игнорируется', () => {
    const c = loadConfig({
      NODE_ENV: 'production',
      ENCRYPTION_KEY: Buffer.alloc(32, 1).toString('base64'),
      POLARIS_PASSWORD: 'x',
    });
    expect(c.plainPassword).toBeUndefined();
  });
});

describe('шифрование', () => {
  const key = Buffer.alloc(32, 9);
  it('round-trip', () => {
    const enc = encryptSecret('секрет-токен', key);
    expect(enc).not.toContain('секрет');
    expect(decryptSecret(enc, key)).toBe('секрет-токен');
  });
  it('не расшифровывается чужим ключом и портится при подмене', () => {
    const enc = encryptSecret('abc', key);
    expect(() => decryptSecret(enc, Buffer.alloc(32, 1))).toThrow();
    const [iv, tag, ct] = enc.split('.');
    expect(() => decryptSecret(`${iv}.${tag}.${Buffer.from('xx').toString('base64url')}`, key)).toThrow();
    expect(ct).toBeTruthy();
  });
});

describe('redact', () => {
  it('скрывает секреты по имени поля и по виду значения', () => {
    const out = redact({
      query: 'погода',
      apiKey: 'AIza' + 'x'.repeat(35),
      nested: { access_token: 'abc', maxTokens: 1000 },
      note: 'мой ключ sk-' + 'a'.repeat(30),
      header: 'Bearer abcdefghijklmnop12345',
    }) as Record<string, unknown>;
    const json = JSON.stringify(out);
    expect(json).not.toContain('AIza');
    expect(json).not.toContain('sk-aaaa');
    expect(json).not.toContain('abcdefghijklmnop12345');
    expect((out.nested as Record<string, unknown>).access_token).toBe('[скрыто]');
    expect((out.nested as Record<string, unknown>).maxTokens).toBe(1000);
    expect(out.query).toBe('погода');
  });
  it('усекает длинные строки', () => {
    expect(redactString('я'.repeat(5000)).length).toBeLessThan(2100);
  });
});

describe('пути файлов', () => {
  it('нормализует и отвергает опасные', () => {
    expect(normalizePath('/a/b.txt')).toBe('a/b.txt');
    expect(normalizePath('dir/')).toBe('dir');
    for (const bad of ['', '..', 'a/../b', 'a//b', '.', 'a\\b', 'a/\u0000b'])
      expect(() => normalizePath(bad)).toThrow();
    expect(() => normalizeUserPath('_trash/x')).toThrow();
    expect(() => normalizeUserPath('_versions/x')).toThrow();
  });
});

describe('время и расписание', () => {
  it('start of day в часовом поясе', () => {
    const d = new Date('2026-03-10T22:30:00Z'); // 01:30 11 марта в Москве (UTC+3)
    expect(startOfDay(d, 'Europe/Moscow').toISOString()).toBe('2026-03-10T21:00:00.000Z');
    expect(dayKey(d, 'Europe/Moscow')).toBe('2026-03-11');
    expect(dayKey(d, 'UTC')).toBe('2026-03-10');
    expect(zonedParts(d, 'Asia/Almaty').hour).toBe(3);
  });

  it('следующий daily-запуск: сегодня или завтра', () => {
    const tz = 'Europe/Moscow';
    expect(nextDailyRun('08:00', tz, new Date('2026-03-10T03:00:00Z')).toISOString()).toBe('2026-03-10T05:00:00.000Z');
    expect(nextDailyRun('08:00', tz, new Date('2026-03-10T06:00:00Z')).toISOString()).toBe('2026-03-11T05:00:00.000Z');
  });

  it('переход на летнее время не ломает расчёт', () => {
    // Нью-Йорк: 2026-03-08 02:00 → 03:00
    const next = nextDailyRun('09:00', 'America/New_York', new Date('2026-03-07T20:00:00Z'));
    expect(next.toISOString()).toBe('2026-03-08T13:00:00.000Z'); // уже EDT (UTC-4)
  });

  it('firstRun/nextRun', () => {
    const now = new Date('2026-01-01T10:00:00Z');
    expect(firstRun(null, now, 'UTC')).toEqual(now);
    expect(firstRun({ type: 'once', at: '2026-01-02T00:00:00Z' }, now, 'UTC').toISOString()).toBe(
      '2026-01-02T00:00:00.000Z',
    );
    expect(firstRun({ type: 'once', at: '2025-01-02T00:00:00Z' }, now, 'UTC')).toEqual(now);
    expect(nextRun({ type: 'once', at: 'x' }, now, 'UTC')).toBeNull();
    expect(nextRun({ type: 'interval', everyMinutes: 30 }, now, 'UTC')?.toISOString()).toBe('2026-01-01T10:30:00.000Z');
    expect(nextRun(null, now, 'UTC')).toBeNull();
  });
});

describe('миграции', () => {
  it('применяются один раз и создают все таблицы из спецификации', async () => {
    const db = await createTestDb();
    const first = await migrate(db);
    expect(first).toEqual(['0001_init.sql', '0002_push.sql', '0003_attachments.sql']);
    expect(await migrate(db)).toEqual([]);
    const tables = (
      await db.query<{ tablename: string }>(`select tablename from pg_tables where schemaname = 'public'`)
    ).map((r) => r.tablename);
    for (const t of [
      'conversations',
      'messages',
      'tasks',
      'task_steps',
      'memory',
      'actions_log',
      'approvals',
      'provider_credentials',
      'settings',
      'push_subscriptions',
    ]) {
      expect(tables).toContain(t);
    }
    const rls = await db.query<{ relname: string; relrowsecurity: boolean }>(
      `select relname, relrowsecurity from pg_class where relkind = 'r' and relnamespace = 'public'::regnamespace and relname not like '\\_%'`,
    );
    expect(rls.every((r) => r.relrowsecurity)).toBe(true);
    await db.close();
  });
});
