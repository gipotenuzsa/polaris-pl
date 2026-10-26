// Типы ответов сервера (зеркало server/src/services/*). Даты — ISO-строки.

export interface Conversation {
  id: string;
  title: string;
  kind: 'chat' | 'task' | 'summary';
  createdAt: string;
  updatedAt: string;
}

export interface Message {
  id: string;
  seq: number;
  conversationId: string;
  role: 'user' | 'assistant' | 'tool' | 'system';
  content: string;
  toolCalls?: { id: string; name: string; arguments: Record<string, unknown> }[];
  toolCallId?: string;
  toolName?: string;
  status: 'ok' | 'error' | 'pending' | 'rejected';
  approvalId?: string;
  provider?: string;
  model?: string;
  createdAt: string;
}

export interface Approval {
  id: string;
  action: string;
  summary: string;
  args: unknown;
  status: 'pending' | 'approved' | 'rejected';
  taskId?: string;
  conversationId?: string;
  createdAt: string;
  resolvedAt?: string;
}

export type Schedule =
  | { type: 'once'; at: string }
  | { type: 'interval'; everyMinutes: number }
  | { type: 'daily'; time: string; timezone?: string };

export type TaskStatus = 'scheduled' | 'in_progress' | 'awaiting_approval' | 'done' | 'failed' | 'cancelled';

export interface Task {
  id: string;
  goal: string;
  status: TaskStatus;
  schedule: Schedule | null;
  nextRunAt?: string;
  budget: { maxTokens?: number; maxUsd?: number } | null;
  runCount: number;
  conversationId?: string;
  lastResult?: string;
  lastError?: string;
  createdAt: string;
  updatedAt: string;
}

export interface TaskStep {
  id: string;
  seq: number;
  runNo: number;
  type: string;
  input: unknown;
  output: unknown;
  status: string;
  createdAt: string;
}

export interface MemoryItem {
  id: string;
  kind: 'fact' | 'preference';
  content: string;
  source: string;
  createdAt: string;
  updatedAt: string;
}

export interface Note {
  id: string;
  title: string;
  body: string;
  createdAt: string;
  updatedAt: string;
}

export interface AppNotification {
  id: string;
  kind: 'reminder' | 'task_done' | 'task_failed' | 'approval' | 'morning' | 'info';
  title: string;
  body: string;
  ref?: { conversationId?: string; taskId?: string; approvalId?: string };
  read: boolean;
  createdAt: string;
}

export interface ActionEntry {
  id: string;
  tool: string;
  args: Record<string, unknown>;
  summary: string;
  status: 'ok' | 'error' | 'rejected';
  undoable: boolean;
  undone: boolean;
  taskId?: string;
  conversationId?: string;
  createdAt: string;
}

export interface FileEntry {
  path: string;
  name: string;
  size: number;
  updatedAt?: string;
  isDir: boolean;
}

export interface ProviderStatus {
  id: 'chatgpt';
  label: string;
  model: string;
  available: boolean;
  cooldownUntil?: string;
}

export interface ChatGptStatus {
  enabled: boolean;
  connected: boolean;
  accountId?: string;
  email?: string;
  plan?: string;
  expiresAt?: string;
  model: string;
  models: string[];
}

export interface BudgetLimits {
  dailyTokens: number;
  dailyUsd: number;
  runTokens: number;
  runUsd: number;
}

export interface BudgetSummary {
  limits: BudgetLimits;
  daily: { tokens: number; usd: number };
  byProvider: { provider: string; tokens: number; usd: number; calls: number }[];
}

export interface MorningSettings {
  enabled: boolean;
  time: string;
  timezone: string;
  lastRunDate?: string;
}

export interface ServerStatus {
  version: string;
  uptimeSeconds: number;
  providers: ProviderStatus[];
  tools: string[];
  scheduler: { enabled: boolean; activeRuns: number };
  files: 'supabase' | 'local';
  unreadNotifications: number;
  pendingApprovals: number;
  timezone: string;
}
