import path from 'node:path';
import type { Config } from './config.js';
import type { AppContext } from './context.js';
import { createDb } from './db/index.js';
import { migrate } from './db/migrate.js';
import type { Db } from './db/types.js';
import { ProviderChain } from './providers/chain.js';
import { ChatGptAuth } from './providers/chatgpt/auth.js';
import { ChatGptProvider } from './providers/chatgpt/provider.js';
import type { ModelProvider } from './providers/types.js';
import { ActionsService } from './services/actions.js';
import { ApprovalsService } from './services/approvals.js';
import { BudgetService } from './services/budget.js';
import { CompactionService } from './services/compaction.js';
import { ConversationService } from './services/conversations.js';
import { MemoryService } from './services/memory.js';
import { MorningService } from './services/morning.js';
import { NotesService, RemindersService } from './services/notes.js';
import { NotificationsService } from './services/notifications.js';
import { PushService, type PushSender } from './services/push.js';
import { RunManager } from './services/runs.js';
import { Scheduler } from './services/scheduler.js';
import { SettingsService } from './services/settings.js';
import { TaskService } from './services/tasks.js';
import { LocalFileStore } from './storage/local.js';
import { SupabaseFileStore } from './storage/supabase.js';
import type { FileStore } from './storage/types.js';
import { BrowserService, browserTools } from './tools/browser.js';
import { filesTools } from './tools/filesTools.js';
import { historyTools } from './tools/historyTools.js';
import { memoryTools } from './tools/memoryTools.js';
import { notesTools } from './tools/notesTools.js';
import { ToolRegistry } from './tools/registry.js';
import { tasksTools } from './tools/tasksTools.js';
import type { AnyTool } from './tools/types.js';
import { readUrlTool, webSearchTool } from './tools/web.js';
import { silentLogger, type Logger } from './util/logger.js';

export interface BootstrapOptions {
  config: Config;
  db?: Db;
  log?: Logger;
  fetch?: typeof fetch;
  clock?: () => Date;
  /** Подмена провайдеров (тесты). */
  providers?: ModelProvider[];
  files?: FileStore;
  /** Подмена отправителя Web Push (тесты). */
  pushSender?: PushSender;
  /** Дополнительные инструменты (тесты, расширения). */
  extraTools?: AnyTool[];
}

/** Единственный провайдер моделей — ChatGPT по OAuth (подписка владельца инстанса). */
function buildProviders(ctx: AppContext): ModelProvider[] {
  return [new ChatGptProvider(ctx)];
}

function buildFiles(config: Config): FileStore {
  if (config.supabase.url && config.supabase.serviceKey) {
    return new SupabaseFileStore(config.supabase.url, config.supabase.serviceKey, config.supabase.bucket);
  }
  return new LocalFileStore(
    config.localFilesDir ?? path.join(config.dataDir === 'memory://' ? '.' : config.dataDir, 'files'),
  );
}

export async function createContext(opts: BootstrapOptions): Promise<AppContext> {
  const { config } = opts;
  const log = opts.log ?? silentLogger;
  const db = opts.db ?? (await createDb(config));
  if (config.autoMigrate) {
    const ran = await migrate(db, config.migrationsDir);
    if (ran.length) log.info({ migrations: ran }, 'Применены миграции');
  }

  const ctx = { config, db, log, clock: opts.clock ?? (() => new Date()), fetch: opts.fetch ?? fetch } as AppContext;
  ctx.settings = new SettingsService(ctx);
  ctx.budget = new BudgetService(ctx);
  ctx.chatgpt = new ChatGptAuth(ctx);
  ctx.files = opts.files ?? buildFiles(config);
  ctx.actions = new ActionsService(ctx);
  ctx.approvals = new ApprovalsService(ctx);
  ctx.memory = new MemoryService(ctx);
  ctx.notes = new NotesService(ctx);
  ctx.reminders = new RemindersService(ctx);
  ctx.notifications = new NotificationsService(ctx);
  ctx.push = new PushService(ctx, opts.pushSender);
  ctx.conversations = new ConversationService(ctx);
  ctx.compaction = new CompactionService(ctx);
  ctx.runs = new RunManager(ctx);
  ctx.tasks = new TaskService(ctx);
  ctx.morning = new MorningService(ctx);
  ctx.scheduler = new Scheduler(ctx);
  ctx.providers = new ProviderChain(opts.providers ?? buildProviders(ctx), {
    timeoutMs: config.providers.timeoutMs,
    log,
  });

  const tools: AnyTool[] = [
    ...notesTools(),
    ...memoryTools(),
    ...filesTools(),
    ...tasksTools(),
    ...historyTools(),
    readUrlTool(config.allowPrivateNetwork),
    ...(config.braveApiKey ? [webSearchTool(config.braveApiKey, ctx.fetch)] : []),
    ...(config.browser.enabled ? browserTools(new BrowserService(config, log), config.allowPrivateNetwork) : []),
    ...(opts.extraTools ?? []),
  ];
  ctx.tools = new ToolRegistry(tools);
  return ctx;
}
