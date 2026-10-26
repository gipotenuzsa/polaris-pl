import type { Config } from './config.js';
import type { Db } from './db/types.js';
import type { ProviderChain } from './providers/chain.js';
import type { ChatGptAuth } from './providers/chatgpt/auth.js';
import type { ActionsService } from './services/actions.js';
import type { ApprovalsService } from './services/approvals.js';
import type { BackupService } from './services/backup.js';
import type { BudgetService } from './services/budget.js';
import type { CheckinsService } from './services/checkins.js';
import type { CompactionService } from './services/compaction.js';
import type { ConversationService } from './services/conversations.js';
import type { MemoryService } from './services/memory.js';
import type { MorningService } from './services/morning.js';
import type { NotesService, RemindersService } from './services/notes.js';
import type { NotificationsService } from './services/notifications.js';
import type { PushService } from './services/push.js';
import type { RunManager } from './services/runs.js';
import type { Scheduler } from './services/scheduler.js';
import type { SettingsService } from './services/settings.js';
import type { TaskService } from './services/tasks.js';
import type { FileStore } from './storage/types.js';
import type { ToolRegistry } from './tools/registry.js';
import type { Logger } from './util/logger.js';

/**
 * Контейнер зависимостей. Сервисы создаются в createContext() и обращаются друг к другу через него —
 * это снимает циклы (approvals → runs → agent → tools → approvals).
 */
export interface AppContext {
  config: Config;
  db: Db;
  log: Logger;
  clock: () => Date;
  fetch: typeof fetch;

  settings: SettingsService;
  budget: BudgetService;
  providers: ProviderChain;
  chatgpt: ChatGptAuth;
  files: FileStore;
  tools: ToolRegistry;
  actions: ActionsService;
  approvals: ApprovalsService;
  memory: MemoryService;
  notes: NotesService;
  reminders: RemindersService;
  notifications: NotificationsService;
  push: PushService;
  conversations: ConversationService;
  compaction: CompactionService;
  backup: BackupService;
  checkins: CheckinsService;
  runs: RunManager;
  tasks: TaskService;
  morning: MorningService;
  scheduler: Scheduler;
}
