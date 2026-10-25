import { randomUUID } from 'node:crypto';
import { providerFetch, safeJsonParse, type FetchFn } from './http.js';
import {
  ProviderError,
  type ChatMessage,
  type ChatRequest,
  type ChatResponse,
  type ModelProvider,
  type ProviderId,
  type ToolCall,
} from './types.js';

export interface OpenAICompatOptions {
  id: ProviderId;
  label: string;
  baseUrl: string;
  model: string;
  apiKey?: string;
  extraHeaders?: Record<string, string>;
  /** Без ключа провайдер считается ненастроенным (OpenRouter). Ollama работает без ключа. */
  requireKey?: boolean;
  /** OpenRouter: просим вернуть стоимость запроса. */
  includeCost?: boolean;
  fetch?: FetchFn;
}

interface OpenAIMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: { id: string; type: 'function'; function: { name: string; arguments: string } }[];
  tool_call_id?: string;
}

export function toOpenAIMessages(messages: ChatMessage[]): OpenAIMessage[] {
  return messages.map((m): OpenAIMessage => {
    switch (m.role) {
      case 'assistant':
        return {
          role: 'assistant',
          content: m.content || (m.toolCalls?.length ? null : ''),
          ...(m.toolCalls?.length
            ? {
                tool_calls: m.toolCalls.map((tc) => ({
                  id: tc.id,
                  type: 'function' as const,
                  function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
                })),
              }
            : {}),
        };
      case 'tool':
        return { role: 'tool', tool_call_id: m.toolCallId, content: m.content };
      default:
        return { role: m.role, content: m.content };
    }
  });
}

interface OpenAIResponse {
  choices?: {
    message?: {
      content?: string | null;
      tool_calls?: { id?: string; function?: { name?: string; arguments?: string } }[];
    };
  }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number };
  model?: string;
  error?: { message?: string; code?: number | string };
}

/** Клиент любого OpenAI-совместимого `/chat/completions`: OpenRouter, Ollama. */
export class OpenAICompatProvider implements ModelProvider {
  readonly id: ProviderId;
  readonly label: string;
  private readonly fetchFn: FetchFn;

  constructor(private readonly opts: OpenAICompatOptions) {
    this.id = opts.id;
    this.label = opts.label;
    this.fetchFn = opts.fetch ?? fetch;
  }

  currentModel(): string {
    return this.opts.model;
  }

  isAvailable(): boolean {
    return Boolean(this.opts.baseUrl && this.opts.model && (!this.opts.requireKey || this.opts.apiKey));
  }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    const body: Record<string, unknown> = {
      model: this.opts.model,
      messages: toOpenAIMessages(req.messages),
    };
    if (req.tools?.length) {
      body.tools = req.tools.map((t) => ({
        type: 'function',
        function: { name: t.name, description: t.description, parameters: t.parameters },
      }));
      body.tool_choice = 'auto';
    }
    if (req.maxTokens) body.max_tokens = req.maxTokens;
    if (this.opts.includeCost) body.usage = { include: true };

    const headers: Record<string, string> = { 'content-type': 'application/json', ...this.opts.extraHeaders };
    if (this.opts.apiKey) headers.authorization = `Bearer ${this.opts.apiKey}`;

    const res = await providerFetch(
      this.id,
      this.fetchFn,
      `${this.opts.baseUrl.replace(/\/+$/, '')}/chat/completions`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: req.signal,
      },
    );

    const data = (await res.json().catch(() => ({}))) as OpenAIResponse;
    if (data.error) {
      const code = Number(data.error.code);
      throw new ProviderError(
        this.id,
        code === 429 ? 'rate_limit' : code >= 500 ? 'server' : 'bad_request',
        `${this.id}: ${data.error.message ?? 'ошибка провайдера'}`,
        Number.isFinite(code) ? code : undefined,
      );
    }

    const msg = data.choices?.[0]?.message;
    const toolCalls: ToolCall[] = (msg?.tool_calls ?? []).map((tc) => ({
      id: tc.id || `call_${randomUUID().slice(0, 12)}`,
      name: tc.function?.name ?? '',
      arguments: safeJsonParse(tc.function?.arguments ?? ''),
    }));
    const content = msg?.content ?? '';
    if (!content.trim() && toolCalls.length === 0) {
      throw new ProviderError(this.id, 'empty', `${this.id}: пустой ответ модели`);
    }

    return {
      content,
      toolCalls,
      usage: {
        promptTokens: data.usage?.prompt_tokens ?? 0,
        completionTokens: data.usage?.completion_tokens ?? 0,
        costUsd: typeof data.usage?.cost === 'number' ? data.usage.cost : undefined,
      },
      provider: this.id,
      model: data.model ?? this.opts.model,
    };
  }
}
