import { randomUUID } from 'node:crypto';
import { providerFetch, type FetchFn } from './http.js';
import {
  ProviderError,
  type ChatMessage,
  type ChatRequest,
  type ChatResponse,
  type JsonSchema,
  type ModelProvider,
  type ToolCall,
} from './types.js';

const BASE = 'https://generativelanguage.googleapis.com/v1beta';
/** Документированная заглушка для вызовов, сделанных другой моделью (Gemini 3 требует thoughtSignature). */
const SKIP_SIGNATURE = 'skip_thought_signature_validator';

interface GPart {
  text?: string;
  thought?: boolean;
  thoughtSignature?: string;
  functionCall?: { name: string; args?: Record<string, unknown> };
  functionResponse?: { name: string; response: Record<string, unknown> };
}
interface GContent {
  role: 'user' | 'model';
  parts: GPart[];
}

const ALLOWED_SCHEMA_KEYS = new Set([
  'type',
  'description',
  'properties',
  'required',
  'enum',
  'items',
  'format',
  'nullable',
]);

/** Gemini принимает подмножество OpenAPI-схемы: убираем $schema, additionalProperties, default и т.п. */
export function toGeminiSchema(schema: JsonSchema): JsonSchema {
  const out: JsonSchema = {};
  for (const [k, v] of Object.entries(schema)) {
    if (!ALLOWED_SCHEMA_KEYS.has(k)) continue;
    if (k === 'properties' && v && typeof v === 'object') {
      out.properties = Object.fromEntries(
        Object.entries(v as Record<string, JsonSchema>).map(([name, s]) => [name, toGeminiSchema(s)]),
      );
    } else if (k === 'items' && v && typeof v === 'object') {
      out.items = toGeminiSchema(v as JsonSchema);
    } else {
      out[k] = v;
    }
  }
  // anyOf с null (zod .nullable()/.optional()) → берём первый непустой вариант
  const anyOf = schema.anyOf as JsonSchema[] | undefined;
  if (anyOf && !out.type) {
    const first = anyOf.find((s) => s.type !== 'null');
    if (first) Object.assign(out, toGeminiSchema(first), { nullable: true });
  }
  return out;
}

export function toGeminiContents(messages: ChatMessage[], model: string): { system?: string; contents: GContent[] } {
  const systemParts: string[] = [];
  const contents: GContent[] = [];
  const needsSignature = /gemini-3/i.test(model);

  for (const m of messages) {
    if (m.role === 'system') {
      systemParts.push(m.content);
    } else if (m.role === 'user') {
      contents.push({ role: 'user', parts: [{ text: m.content }] });
    } else if (m.role === 'assistant') {
      const parts: GPart[] = [];
      if (m.content) parts.push({ text: m.content });
      for (const tc of m.toolCalls ?? []) {
        const sig = typeof tc.meta?.thoughtSignature === 'string' ? tc.meta.thoughtSignature : undefined;
        parts.push({
          functionCall: { name: tc.name, args: tc.arguments },
          ...(sig ? { thoughtSignature: sig } : needsSignature ? { thoughtSignature: SKIP_SIGNATURE } : {}),
        });
      }
      if (parts.length) contents.push({ role: 'model', parts });
    } else {
      const part: GPart = { functionResponse: { name: m.name, response: { result: m.content } } };
      const last = contents[contents.length - 1];
      if (last && last.role === 'user' && last.parts.every((p) => p.functionResponse)) last.parts.push(part);
      else contents.push({ role: 'user', parts: [part] });
    }
  }
  return { system: systemParts.length ? systemParts.join('\n\n') : undefined, contents };
}

interface GeminiResponse {
  candidates?: { content?: { parts?: GPart[] }; finishReason?: string }[];
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; thoughtsTokenCount?: number };
  promptFeedback?: { blockReason?: string };
  modelVersion?: string;
}

export interface GeminiOptions {
  apiKey: string;
  model: string;
  fetch?: FetchFn;
}

export class GeminiProvider implements ModelProvider {
  readonly id = 'gemini' as const;
  readonly label = 'Google Gemini';
  private readonly fetchFn: FetchFn;

  constructor(private readonly opts: GeminiOptions) {
    this.fetchFn = opts.fetch ?? fetch;
  }

  currentModel(): string {
    return this.opts.model;
  }

  isAvailable(): boolean {
    return Boolean(this.opts.apiKey);
  }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    const { system, contents } = toGeminiContents(req.messages, this.opts.model);
    const body: Record<string, unknown> = { contents };
    if (system) body.systemInstruction = { parts: [{ text: system }] };
    if (req.tools?.length) {
      body.tools = [
        {
          functionDeclarations: req.tools.map((t) => ({
            name: t.name,
            description: t.description,
            parameters: toGeminiSchema(t.parameters),
          })),
        },
      ];
    }
    if (req.maxTokens) body.generationConfig = { maxOutputTokens: req.maxTokens };

    const res = await providerFetch(
      this.id,
      this.fetchFn,
      `${BASE}/models/${encodeURIComponent(this.opts.model)}:generateContent`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-goog-api-key': this.opts.apiKey },
        body: JSON.stringify(body),
        signal: req.signal,
      },
    );
    const data = (await res.json().catch(() => ({}))) as GeminiResponse;

    if (data.promptFeedback?.blockReason) {
      throw new ProviderError(
        this.id,
        'bad_request',
        `gemini: запрос заблокирован (${data.promptFeedback.blockReason})`,
      );
    }
    const parts = data.candidates?.[0]?.content?.parts ?? [];
    let content = '';
    const toolCalls: ToolCall[] = [];
    for (const p of parts) {
      if (p.thought) continue;
      if (p.text) content += p.text;
      if (p.functionCall) {
        toolCalls.push({
          id: `call_${randomUUID().slice(0, 12)}`,
          name: p.functionCall.name,
          arguments: p.functionCall.args ?? {},
          ...(p.thoughtSignature ? { meta: { thoughtSignature: p.thoughtSignature } } : {}),
        });
      }
    }
    if (!content.trim() && toolCalls.length === 0) {
      throw new ProviderError(
        this.id,
        'empty',
        `gemini: пустой ответ (${data.candidates?.[0]?.finishReason ?? 'без причины'})`,
      );
    }
    const u = data.usageMetadata;
    return {
      content,
      toolCalls,
      usage: {
        promptTokens: u?.promptTokenCount ?? 0,
        completionTokens: (u?.candidatesTokenCount ?? 0) + (u?.thoughtsTokenCount ?? 0),
      },
      provider: this.id,
      model: data.modelVersion ?? this.opts.model,
    };
  }
}
