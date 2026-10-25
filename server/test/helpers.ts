import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import bcrypt from 'bcryptjs';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { createContext } from '../src/bootstrap.js';
import { loadConfig, type Config } from '../src/config.js';
import type { AppContext } from '../src/context.js';
import { createDb, createMemoryDb } from '../src/db/index.js';
import type { Db } from '../src/db/types.js';
import type { ChatRequest, ChatResponse, ModelProvider, ProviderId, ToolCall } from '../src/providers/types.js';
import { LocalFileStore } from '../src/storage/local.js';
import type { AnyTool } from '../src/tools/types.js';

export const TEST_PASSWORD = 'correct horse battery';

/**
 * По умолчанию тесты идут на встроенном PGlite. С TEST_DATABASE_URL (настоящий Postgres, как в Supabase)
 * каждое окружение получает чистую схему; запускать с `--no-file-parallelism`.
 */
export async function createTestDb(): Promise<Db> {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) return createMemoryDb();
  const db = await createDb({ databaseUrl: url, databaseSsl: 'false', dataDir: '', isProd: false });
  await db.exec('drop schema if exists public cascade; create schema public;');
  return db;
}

export function testConfig(overrides: Record<string, string> = {}): Config {
  return loadConfig({
    NODE_ENV: 'test',
    DATA_DIR: 'memory://',
    POLARIS_PASSWORD_HASH: bcrypt.hashSync(TEST_PASSWORD, 4),
    CRON_SECRET: 'cron-secret-for-tests',
    SCHEDULER_ENABLED: 'false',
    ...overrides,
  });
}

export type Script = (req: ChatRequest, call: number) => Partial<Omit<ChatResponse, 'provider'>> | Error;

/** Провайдер с заранее заданным поведением — вместо реальных API. */
export class ScriptedProvider implements ModelProvider {
  calls: ChatRequest[] = [];
  constructor(
    readonly id: ProviderId,
    private readonly script: Script,
    private readonly available = true,
    readonly label = id,
  ) {}
  currentModel() {
    return `${this.id}-test-model`;
  }
  isAvailable() {
    return this.available;
  }
  async chat(req: ChatRequest): Promise<ChatResponse> {
    this.calls.push(req);
    const out = this.script(req, this.calls.length);
    if (out instanceof Error) throw out;
    return {
      content: out.content ?? '',
      toolCalls: out.toolCalls ?? [],
      usage: out.usage ?? { promptTokens: 100, completionTokens: 20 },
      provider: this.id,
      model: out.model ?? this.currentModel(),
    };
  }
}

export const toolCall = (
  name: string,
  args: Record<string, unknown>,
  id = `call_${name}_${Math.random().toString(36).slice(2, 8)}`,
): ToolCall => ({
  id,
  name,
  arguments: args,
});

export interface TestEnv {
  ctx: AppContext;
  app: FastifyInstance;
  provider: ScriptedProvider;
  close(): Promise<void>;
}

export async function createTestEnv(
  opts: {
    script?: Script;
    config?: Record<string, string>;
    clock?: () => Date;
    extraTools?: AnyTool[];
    providers?: ModelProvider[];
    fetch?: typeof fetch;
  } = {},
): Promise<TestEnv> {
  const config = testConfig(opts.config);
  const db = await createTestDb();
  const dir = await mkdtemp(path.join(os.tmpdir(), 'polaris-files-'));
  const provider = new ScriptedProvider('openrouter', opts.script ?? (() => ({ content: 'ok' })));
  const ctx = await createContext({
    config,
    db,
    clock: opts.clock,
    fetch: opts.fetch,
    providers: opts.providers ?? [provider],
    files: new LocalFileStore(dir),
    extraTools: opts.extraTools,
  });
  const app = await buildApp(ctx);
  await app.ready();
  return {
    ctx,
    app,
    provider,
    async close() {
      await ctx.runs.idle();
      await app.close();
      await db.close();
    },
  };
}

/** Входит и возвращает заголовки для авторизованных запросов (Bearer). */
export async function login(app: FastifyInstance): Promise<Record<string, string>> {
  const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { password: TEST_PASSWORD } });
  const { token } = res.json() as { token: string };
  return { authorization: `Bearer ${token}` };
}

export async function waitFor<T>(
  fn: () => Promise<T | undefined | false>,
  timeoutMs = 10_000,
  stepMs = 25,
): Promise<T> {
  const started = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - started > timeoutMs) throw new Error('waitFor: таймаут');
    await new Promise((r) => setTimeout(r, stepMs));
  }
}
