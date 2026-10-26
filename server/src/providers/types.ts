export type JsonSchema = Record<string, unknown>;

export interface ToolSpec {
  name: string;
  description: string;
  parameters: JsonSchema;
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  /** Служебные данные провайдера (например, thoughtSignature Gemini); другим провайдерам не передаются. */
  meta?: Record<string, unknown>;
}

export type ChatMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string; toolCalls?: ToolCall[] }
  | { role: 'tool'; toolCallId: string; name: string; content: string };

export interface Usage {
  promptTokens: number;
  completionTokens: number;
  /** Реальная стоимость, если провайдер её сообщает (OpenRouter). */
  costUsd?: number;
}

export interface ChatRequest {
  messages: ChatMessage[];
  tools?: ToolSpec[];
  maxTokens?: number;
  signal?: AbortSignal;
  /** Вызывается по мере поступления текста ответа (стриминг). Необязателен; провайдер без стриминга его не зовёт. */
  onText?: (delta: string) => void;
}

export interface ChatResponse {
  content: string;
  toolCalls: ToolCall[];
  usage: Usage;
  provider: ProviderId;
  model: string;
}

export type ProviderId = 'openrouter' | 'gemini' | 'ollama' | 'chatgpt';

export interface ModelProvider {
  readonly id: ProviderId;
  readonly label: string;
  /** Текущая модель (для ChatGPT может меняться в настройках). */
  currentModel(): Promise<string> | string;
  /** Настроен ли провайдер и разрешён ли он сейчас. */
  isAvailable(): Promise<boolean> | boolean;
  chat(req: ChatRequest): Promise<ChatResponse>;
}

export type ProviderErrorKind = 'rate_limit' | 'timeout' | 'auth' | 'server' | 'bad_request' | 'network' | 'empty';

export class ProviderError extends Error {
  constructor(
    public readonly provider: ProviderId,
    public readonly kind: ProviderErrorKind,
    message: string,
    public readonly status?: number,
    public readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'ProviderError';
  }
}

export function kindFromStatus(status: number): ProviderErrorKind {
  if (status === 429) return 'rate_limit';
  if (status === 401 || status === 403) return 'auth';
  if (status === 408 || status === 504) return 'timeout';
  if (status >= 500) return 'server';
  return 'bad_request';
}

export function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const secs = Number(value);
  if (Number.isFinite(secs)) return Math.max(0, secs) * 1000;
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}
