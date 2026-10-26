import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';
import type {
  ActionEntry,
  Approval,
  AppNotification,
  BudgetLimits,
  BudgetSummary,
  ChatGptStatus,
  Conversation,
  FileEntry,
  MemoryItem,
  Message,
  MorningSettings,
  Note,
  ProviderStatus,
  Schedule,
  ServerStatus,
  Task,
  TaskStep,
} from './types';

const KEY_URL = 'polaris.serverUrl';
const KEY_TOKEN = 'polaris.token';

/** На вебе пишем в localStorage (только режим разработки с другим origin), на устройстве — в защищённое хранилище. */
const storage = {
  async get(key: string): Promise<string | null> {
    try {
      if (Platform.OS === 'web') return globalThis.localStorage?.getItem(key) ?? null;
      return await SecureStore.getItemAsync(key);
    } catch {
      return null;
    }
  },
  async set(key: string, value: string): Promise<void> {
    if (Platform.OS === 'web') globalThis.localStorage?.setItem(key, value);
    else await SecureStore.setItemAsync(key, value);
  },
  async remove(key: string): Promise<void> {
    try {
      if (Platform.OS === 'web') globalThis.localStorage?.removeItem(key);
      else await SecureStore.deleteItemAsync(key);
    } catch {
      /* нечего удалять */
    }
  },
};

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code?: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

let baseUrl = '';
let token: string | null = null;
let onUnauthorized: (() => void) | null = null;

export const setUnauthorizedHandler = (fn: (() => void) | null) => {
  onUnauthorized = fn;
};

export const getBaseUrl = () => baseUrl;
/** Веб, открытый с самого сервера (PWA): сессия держится на httpOnly-cookie, токен не нужен. */
export const usesCookies = () => Platform.OS === 'web' && baseUrl === '';
/** Веб-версия в режиме разработки (Metro на другом порту) показывает поле адреса сервера. */
export const needsServerUrl = () => Platform.OS !== 'web' || process.env.NODE_ENV !== 'production';

export function normalizeServerUrl(input: string): string {
  let url = input.trim().replace(/\/+$/, '');
  if (!url) return '';
  if (!/^https?:\/\//i.test(url)) url = `${/^(localhost|127\.|10\.|192\.168\.)/.test(url) ? 'http' : 'https'}://${url}`;
  return url;
}

export async function restoreSession(): Promise<boolean> {
  baseUrl = (await storage.get(KEY_URL)) ?? '';
  token = await storage.get(KEY_TOKEN);
  try {
    const res = await fetch(`${baseUrl}/api/auth/session`, authInit());
    const data = (await res.json()) as { authenticated?: boolean };
    return Boolean(data.authenticated);
  } catch {
    // сервер недоступен: считаем, что сессия есть, если есть токен, — экран покажет ошибки загрузки
    return Boolean(token) || usesCookies();
  }
}

function authInit(init: RequestInit = {}): RequestInit {
  const headers: Record<string, string> = { ...(init.headers as Record<string, string> | undefined) };
  if (token && !usesCookies()) headers.authorization = `Bearer ${token}`;
  return { ...init, headers, credentials: usesCookies() ? 'same-origin' : 'omit' };
}

export async function login(serverUrl: string, password: string): Promise<void> {
  const url = needsServerUrl() ? normalizeServerUrl(serverUrl) : '';
  if (needsServerUrl() && !url) throw new ApiError('Укажите адрес сервера', 0);
  baseUrl = url;
  let res: Response;
  try {
    res = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password }),
      credentials: usesCookies() ? 'same-origin' : 'omit',
    });
  } catch {
    throw new ApiError('Не удалось связаться с сервером. Проверьте адрес и сеть.', 0);
  }
  const data = (await res.json().catch(() => ({}))) as { token?: string; message?: string };
  if (!res.ok) throw new ApiError(data.message ?? 'Не удалось войти', res.status);
  token = data.token ?? null;
  await storage.set(KEY_URL, baseUrl);
  if (token && !usesCookies()) await storage.set(KEY_TOKEN, token);
}

export async function logout(): Promise<void> {
  try {
    await fetch(`${baseUrl}/api/auth/logout`, authInit({ method: 'POST' }));
  } catch {
    /* сервер недоступен — всё равно забываем сессию локально */
  }
  token = null;
  await storage.remove(KEY_TOKEN);
}

export async function request<T>(
  path: string,
  opts: { method?: string; body?: unknown; raw?: boolean } = {},
): Promise<T> {
  const init = authInit({
    method: opts.method ?? 'GET',
    headers: opts.body !== undefined ? { 'content-type': 'application/json' } : {},
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  let res: Response;
  try {
    res = await fetch(`${baseUrl}${path}`, init);
  } catch {
    throw new ApiError('Нет связи с сервером', 0, 'network');
  }
  const text = await res.text();
  let data: unknown = null;
  if (opts.raw && res.ok) return text as T;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!res.ok) {
    if (res.status === 401) onUnauthorized?.();
    const body = (data ?? {}) as { message?: string; error?: string };
    throw new ApiError(body.message ?? `Ошибка ${res.status}`, res.status, body.error);
  }
  return data as T;
}

const get = <T>(path: string) => request<T>(path);
const post = <T>(path: string, body?: unknown) => request<T>(path, { method: 'POST', body: body ?? {} });
const put = <T>(path: string, body: unknown) => request<T>(path, { method: 'PUT', body });
const patch = <T>(path: string, body: unknown) => request<T>(path, { method: 'PATCH', body });
const del = <T>(path: string) => request<T>(path, { method: 'DELETE' });
const q = (params: Record<string, string | number | boolean | undefined>) => {
  const s = Object.entries(params)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    .join('&');
  return s ? `?${s}` : '';
};

export const api = {
  status: () => get<ServerStatus>('/api/status'),

  conversations: (kind: Conversation['kind'] = 'chat') =>
    get<{ conversations: Conversation[] }>(`/api/conversations${q({ kind })}`),
  createConversation: () => post<{ conversation: Conversation }>('/api/conversations'),
  conversation: (id: string, after = 0) =>
    get<{
      conversation: Conversation;
      messages: Message[];
      running: boolean;
      /** Текст ответа, который модель пишет прямо сейчас (стриминг) */
      live: string;
      pendingApprovals: Approval[];
    }>(
      `/api/conversations/${id}${q({ after })}`,
    ),
  renameConversation: (id: string, title: string) => patch<{ ok: true }>(`/api/conversations/${id}`, { title }),
  deleteConversation: (id: string) => del<{ ok: true }>(`/api/conversations/${id}`),
  stopConversation: (id: string) => post<{ stopped: boolean }>(`/api/conversations/${id}/stop`),
  sendMessage: (id: string, content: string) =>
    post<{ message: Message; running: boolean }>(`/api/conversations/${id}/messages`, { content }),

  memory: () => get<{ items: MemoryItem[] }>('/api/memory'),
  addMemory: (kind: MemoryItem['kind'], content: string) =>
    post<{ item: MemoryItem }>('/api/memory', { kind, content }),
  updateMemory: (id: string, patchBody: { kind?: MemoryItem['kind']; content?: string }) =>
    patch<{ item: MemoryItem }>(`/api/memory/${id}`, patchBody),
  deleteMemory: (id: string) => del<{ ok: true }>(`/api/memory/${id}`),

  tasks: () => get<{ items: Task[] }>('/api/tasks'),
  task: (id: string) => get<{ task: Task; steps: TaskStep[] }>(`/api/tasks/${id}`),
  createTask: (goal: string, schedule: Schedule | null) => post<{ item: Task }>('/api/tasks', { goal, schedule }),
  runTask: (id: string) => post<{ item: Task }>(`/api/tasks/${id}/run`),
  cancelTask: (id: string) => post<{ item: Task }>(`/api/tasks/${id}/cancel`),
  deleteTask: (id: string) => del<{ ok: true }>(`/api/tasks/${id}`),

  approvals: (status?: Approval['status']) => get<{ items: Approval[] }>(`/api/approvals${q({ status })}`),
  approve: (id: string) => post<{ item: Approval }>(`/api/approvals/${id}/approve`),
  reject: (id: string) => post<{ item: Approval }>(`/api/approvals/${id}/reject`),

  actions: (limit = 100) => get<{ items: ActionEntry[] }>(`/api/actions${q({ limit })}`),
  undoAction: (id: string) => post<{ message: string }>(`/api/actions/${id}/undo`),

  notes: () => get<{ items: Note[] }>('/api/notes'),
  saveNote: (id: string | null, title: string, body: string) =>
    id
      ? patch<{ item: Note }>(`/api/notes/${id}`, { title, body })
      : post<{ item: Note }>('/api/notes', { title, body }),
  deleteNote: (id: string) => del<{ ok: true }>(`/api/notes/${id}`),

  notifications: () => get<{ items: AppNotification[]; unread: number }>('/api/notifications'),
  markRead: (id: string) => post<{ ok: true }>(`/api/notifications/${id}/read`),
  markAllRead: () => post<{ ok: true }>('/api/notifications/read-all'),

  files: (path = '') => get<{ path: string; entries: FileEntry[] }>(`/api/files${q({ path: path || undefined })}`),
  fileText: (path: string) => request<string>(`/api/files/content${q({ path })}`, { raw: true }),
  deleteFile: (path: string) => del<{ ok: true }>(`/api/files${q({ path })}`),

  budget: () => get<BudgetSummary>('/api/budget'),
  saveBudget: (limits: BudgetLimits) => put<BudgetSummary>('/api/budget', limits),

  settings: () => get<{ morning: MorningSettings; agent: { instructions: string }; timezone: string }>('/api/settings'),
  saveMorning: (m: { enabled: boolean; time: string; timezone: string }) =>
    put<{ morning: MorningSettings }>('/api/settings/morning', m),
  saveAgent: (instructions: string) =>
    put<{ agent: { instructions: string } }>('/api/settings/agent', { instructions }),
  runMorning: () => post<{ conversationId: string }>('/api/morning/run'),

  providers: () => get<{ providers: ProviderStatus[]; chatgpt: ChatGptStatus }>('/api/providers'),
  chatgptSettings: (s: { enabled?: boolean; model?: string }) =>
    put<ChatGptStatus>('/api/providers/chatgpt/settings', s),
  chatgptConnect: () => post<{ authUrl: string; state: string; redirectUri: string }>('/api/providers/chatgpt/connect'),
  chatgptCallback: (url: string) => post<ChatGptStatus>('/api/providers/chatgpt/callback', { url }),
  chatgptCheck: () =>
    post<{ ok: boolean; model: string; error?: string; modelNotFound?: boolean; switchedFrom?: string }>(
      '/api/providers/chatgpt/check',
    ),
  chatgptDisconnect: () => post<ChatGptStatus>('/api/providers/chatgpt/disconnect'),

  pushStatus: () => get<{ publicKey: string; subscriptions: number }>('/api/push/status'),
  pushSubscribe: (sub: { endpoint: string; keys: { p256dh: string; auth: string } }) =>
    post<{ ok: true; subscriptions: number }>('/api/push/subscribe', sub),
  pushUnsubscribe: (endpoint: string) =>
    post<{ ok: true; subscriptions: number }>('/api/push/unsubscribe', { endpoint }),
  pushTest: () => post<{ sent: number; removed: number; failed: number }>('/api/push/test'),
};
