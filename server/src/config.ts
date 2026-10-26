import { randomBytes } from 'node:crypto';
import { z } from 'zod';

/** Пустые строки в .env считаем «не задано». */
const blankToUndefined = (v: unknown) => (typeof v === 'string' && v.trim() === '' ? undefined : v);
const optStr = z.preprocess(blankToUndefined, z.string().optional());
const str = (def: string) => z.preprocess(blankToUndefined, z.string().default(def));
const int = (def: number) => z.preprocess(blankToUndefined, z.coerce.number().int().default(def));
const num = (def: number) => z.preprocess(blankToUndefined, z.coerce.number().default(def));
const bool = (def: boolean) =>
  z.preprocess(
    blankToUndefined,
    z
      .union([z.boolean(), z.string()])
      .default(def)
      .transform((v) => (typeof v === 'boolean' ? v : ['true', '1', 'yes', 'on'].includes(v.toLowerCase()))),
  );

const envSchema = z.object({
  NODE_ENV: str('development'),
  PORT: int(8787),
  HOST: str('0.0.0.0'),
  PUBLIC_URL: optStr,
  LOG_LEVEL: str('info'),

  DATABASE_URL: optStr,
  DATABASE_SSL: optStr,
  AUTO_MIGRATE: bool(true),
  DATA_DIR: str('./data'),
  MIGRATIONS_DIR: optStr,
  WEB_DIR: optStr,

  POLARIS_PASSWORD_HASH: optStr,
  POLARIS_PASSWORD: optStr,
  ENCRYPTION_KEY: optStr,
  SESSION_TTL_DAYS: int(30),
  CRON_SECRET: optStr,
  ALLOW_PRIVATE_NETWORK: bool(false),
  CORS_ORIGINS: optStr,
  VAPID_SUBJECT: optStr,

  SUPABASE_URL: optStr,
  SUPABASE_SERVICE_KEY: optStr,
  SUPABASE_BUCKET: str('polaris-files'),
  LOCAL_FILES_DIR: optStr,

  PROVIDER_ORDER: str('openrouter,gemini,ollama'),
  PROVIDER_TIMEOUT_MS: int(60_000),
  OPENROUTER_API_KEY: optStr,
  OPENROUTER_MODEL: str('openrouter/auto'),
  OPENROUTER_BASE_URL: str('https://openrouter.ai/api/v1'),
  GEMINI_API_KEY: optStr,
  GEMINI_MODEL: str('gemini-2.5-flash'),
  OLLAMA_BASE_URL: optStr,
  OLLAMA_MODEL: optStr,

  CHATGPT_CLIENT_ID: str('app_EMoamEEZ73f0CkXaXp7hrann'),
  CHATGPT_ISSUER: str('https://auth.openai.com'),
  CHATGPT_REDIRECT_URI: str('http://localhost:1455/auth/callback'),
  CHATGPT_SCOPE: str('openid profile email offline_access'),
  CHATGPT_ORIGINATOR: str('codex_cli_rs'),
  CHATGPT_BACKEND_URL: str('https://chatgpt.com/backend-api/codex'),
  CHATGPT_MODEL: str('gpt-6-luna'),
  CHATGPT_MODELS: str('gpt-6-luna,gpt-5.1-codex,gpt-5-codex,gpt-5'),

  CHATGPT_WEB_SEARCH: bool(true),

  BROWSER_ENABLED: bool(false),
  BROWSER_WS_ENDPOINT: optStr,
  BROWSER_EXECUTABLE_PATH: optStr,
  BROWSER_MAX_MEMORY_MB: int(300),

  BUDGET_DAILY_TOKENS: int(500_000),
  BUDGET_DAILY_USD: num(2),
  BUDGET_RUN_TOKENS: int(100_000),
  BUDGET_RUN_USD: num(0.5),
  PRICES_JSON: optStr,

  INSTANCE_TIMEZONE: str('UTC'),
  SCHEDULER_ENABLED: bool(true),
  SELF_PING: bool(true),
  SCHEDULER_TICK_SECONDS: int(30),
  MAX_CONCURRENT_RUNS: int(2),
  APPROVAL_TTL_HOURS: int(48),

  AGENT_MAX_STEPS: int(12),
  AGENT_CONTEXT_TOKENS: int(24_000),
  TOOL_TIMEOUT_MS: int(30_000),
});

export interface ModelPrice {
  /** USD за 1 млн входных токенов */
  in: number;
  /** USD за 1 млн выходных токенов */
  out: number;
}

/** Ориентировочные цены; переопределяются через PRICES_JSON. OpenRouter отдаёт стоимость сам. */
const DEFAULT_PRICES: Record<string, ModelPrice> = {
  'gemini-2.5-flash': { in: 0.3, out: 2.5 },
  'gemini-2.5-flash-lite': { in: 0.1, out: 0.4 },
  'gemini-2.5-pro': { in: 1.25, out: 10 },
};

export interface Config {
  nodeEnv: string;
  isProd: boolean;
  port: number;
  host: string;
  publicUrl?: string;
  logLevel: string;
  databaseUrl?: string;
  databaseSsl?: string;
  autoMigrate: boolean;
  dataDir: string;
  migrationsDir?: string;
  webDir?: string;
  passwordHash?: string;
  plainPassword?: string;
  encryptionKey: Buffer;
  sessionTtlDays: number;
  cookieSecure: boolean;
  cronSecret?: string;
  /** Origin'ы, которым разрешены кросс-доменные запросы (веб-клиент в режиме разработки на другом порту). */
  corsOrigins: string[];
  /** Контакт отправителя Web Push (mailto: или https://); по умолчанию PUBLIC_URL. */
  vapidSubject?: string;
  allowPrivateNetwork: boolean;
  supabase: { url?: string; serviceKey?: string; bucket: string };
  localFilesDir?: string;
  providers: {
    order: string[];
    timeoutMs: number;
    openrouter: { apiKey?: string; model: string; baseUrl: string };
    gemini: { apiKey?: string; model: string };
    ollama: { baseUrl?: string; model?: string };
    chatgpt: {
      clientId: string;
      issuer: string;
      redirectUri: string;
      scope: string;
      originator: string;
      backendUrl: string;
      defaultModel: string;
      models: string[];
      /** Встроенный веб-поиск модели (инструмент web_search Responses API) */
      webSearch: boolean;
    };
  };
  browser: { enabled: boolean; wsEndpoint?: string; executablePath?: string; maxMemoryMb: number };
  budget: { dailyTokens: number; dailyUsd: number; runTokens: number; runUsd: number };
  prices: Record<string, ModelPrice>;
  timezone: string;
  scheduler: { enabled: boolean; tickSeconds: number; maxConcurrentRuns: number };
  /** Сервер сам обращается к своему публичному адресу, чтобы бесплатный Render не усыплял его (только production + https PUBLIC_URL). */
  selfPing: boolean;
  approvalTtlHours: number;
  agent: { maxSteps: number; contextTokens: number; toolTimeoutMs: number };
}

function parseEncryptionKey(raw: string | undefined, isProd: boolean): Buffer {
  if (raw) {
    const asHex = /^[0-9a-fA-F]{64}$/.test(raw) ? Buffer.from(raw, 'hex') : undefined;
    const key = asHex ?? Buffer.from(raw, 'base64');
    if (key.length !== 32) {
      throw new Error(
        'ENCRYPTION_KEY должен быть 32 байта (base64 или 64 hex-символа). Сгенерировать: openssl rand -base64 32',
      );
    }
    return key;
  }
  if (isProd) {
    throw new Error(
      'ENCRYPTION_KEY обязателен в production (шифрует OAuth-токены). Сгенерировать: openssl rand -base64 32',
    );
  }
  return randomBytes(32); // dev: эфемерный ключ, токены не переживут перезапуск
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const msg = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Некорректные переменные окружения: ${msg}`);
  }
  const e = parsed.data;
  const isProd = e.NODE_ENV === 'production';

  let prices = DEFAULT_PRICES;
  if (e.PRICES_JSON) {
    try {
      prices = { ...DEFAULT_PRICES, ...(JSON.parse(e.PRICES_JSON) as Record<string, ModelPrice>) };
    } catch {
      throw new Error('PRICES_JSON — некорректный JSON');
    }
  }

  const order = e.PROVIDER_ORDER.split(',')
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s && s !== 'chatgpt'); // ChatGPT OAuth всегда последний

  return {
    nodeEnv: e.NODE_ENV,
    isProd,
    port: e.PORT,
    host: e.HOST,
    publicUrl: e.PUBLIC_URL,
    logLevel: e.LOG_LEVEL,
    databaseUrl: e.DATABASE_URL,
    databaseSsl: e.DATABASE_SSL,
    autoMigrate: e.AUTO_MIGRATE,
    dataDir: e.DATA_DIR,
    migrationsDir: e.MIGRATIONS_DIR,
    webDir: e.WEB_DIR,
    passwordHash: e.POLARIS_PASSWORD_HASH,
    plainPassword: isProd ? undefined : e.POLARIS_PASSWORD,
    encryptionKey: parseEncryptionKey(e.ENCRYPTION_KEY, isProd),
    sessionTtlDays: e.SESSION_TTL_DAYS,
    cookieSecure: isProd && (e.PUBLIC_URL ? e.PUBLIC_URL.startsWith('https://') : true),
    cronSecret: e.CRON_SECRET,
    vapidSubject: e.VAPID_SUBJECT,
    corsOrigins: (e.CORS_ORIGINS ?? '')
      .split(',')
      .map((s) => s.trim().replace(/\/+$/, ''))
      .filter(Boolean),
    allowPrivateNetwork: e.ALLOW_PRIVATE_NETWORK,
    supabase: { url: e.SUPABASE_URL, serviceKey: e.SUPABASE_SERVICE_KEY, bucket: e.SUPABASE_BUCKET },
    localFilesDir: e.LOCAL_FILES_DIR,
    providers: {
      order,
      timeoutMs: e.PROVIDER_TIMEOUT_MS,
      openrouter: { apiKey: e.OPENROUTER_API_KEY, model: e.OPENROUTER_MODEL, baseUrl: e.OPENROUTER_BASE_URL },
      gemini: { apiKey: e.GEMINI_API_KEY, model: e.GEMINI_MODEL },
      ollama: { baseUrl: e.OLLAMA_BASE_URL, model: e.OLLAMA_MODEL },
      chatgpt: {
        clientId: e.CHATGPT_CLIENT_ID,
        issuer: e.CHATGPT_ISSUER.replace(/\/+$/, ''),
        redirectUri: e.CHATGPT_REDIRECT_URI,
        scope: e.CHATGPT_SCOPE,
        originator: e.CHATGPT_ORIGINATOR,
        backendUrl: e.CHATGPT_BACKEND_URL.replace(/\/+$/, ''),
        defaultModel: e.CHATGPT_MODEL,
        webSearch: e.CHATGPT_WEB_SEARCH,
        models: e.CHATGPT_MODELS.split(',')
          .map((s) => s.trim())
          .filter(Boolean),
      },
    },
    browser: {
      enabled: e.BROWSER_ENABLED,
      wsEndpoint: e.BROWSER_WS_ENDPOINT,
      executablePath: e.BROWSER_EXECUTABLE_PATH,
      maxMemoryMb: e.BROWSER_MAX_MEMORY_MB,
    },
    budget: {
      dailyTokens: e.BUDGET_DAILY_TOKENS,
      dailyUsd: e.BUDGET_DAILY_USD,
      runTokens: e.BUDGET_RUN_TOKENS,
      runUsd: e.BUDGET_RUN_USD,
    },
    prices,
    timezone: e.INSTANCE_TIMEZONE,
    selfPing: e.SELF_PING && isProd,
    scheduler: {
      enabled: e.SCHEDULER_ENABLED,
      tickSeconds: e.SCHEDULER_TICK_SECONDS,
      maxConcurrentRuns: e.MAX_CONCURRENT_RUNS,
    },
    approvalTtlHours: e.APPROVAL_TTL_HOURS,
    agent: { maxSteps: e.AGENT_MAX_STEPS, contextTokens: e.AGENT_CONTEXT_TOKENS, toolTimeoutMs: e.TOOL_TIMEOUT_MS },
  };
}
