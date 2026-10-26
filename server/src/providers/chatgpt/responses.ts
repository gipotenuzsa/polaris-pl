import { safeJsonParse } from '../http.js';
import { parseSse, type SseEvent } from '../sse.js';
import { ProviderError, type ChatMessage, type ChatResponse, type ToolCall, type ToolSpec } from '../types.js';

export const FALLBACK_INSTRUCTIONS = 'You are a helpful assistant.';

export function toResponsesInput(messages: ChatMessage[]): { instructions: string; input: unknown[] } {
  const system: string[] = [];
  const input: unknown[] = [];
  for (const m of messages) {
    switch (m.role) {
      case 'system':
        system.push(m.content);
        break;
      case 'user':
        input.push({ type: 'message', role: 'user', content: [{ type: 'input_text', text: m.content }] });
        break;
      case 'assistant':
        if (m.content) {
          input.push({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: m.content }] });
        }
        for (const tc of m.toolCalls ?? []) {
          input.push({ type: 'function_call', call_id: tc.id, name: tc.name, arguments: JSON.stringify(tc.arguments) });
        }
        break;
      case 'tool':
        input.push({ type: 'function_call_output', call_id: m.toolCallId, output: m.content });
        break;
    }
  }
  return { instructions: system.join('\n\n') || FALLBACK_INSTRUCTIONS, input };
}

export function buildResponsesBody(
  model: string,
  messages: ChatMessage[],
  tools?: ToolSpec[],
): Record<string, unknown> {
  const { instructions, input } = toResponsesInput(messages);
  return {
    model,
    instructions,
    input,
    tools: (tools ?? []).map((t) => ({
      type: 'function',
      name: t.name,
      description: t.description,
      parameters: t.parameters,
      strict: false,
    })),
    tool_choice: 'auto',
    parallel_tool_calls: false,
    store: false,
    stream: true,
    include: [],
  };
}

interface ResponsesEvent {
  type?: string;
  delta?: string;
  item?: {
    type?: string;
    call_id?: string;
    name?: string;
    arguments?: string;
    content?: { type?: string; text?: string }[];
  };
  response?: {
    model?: string;
    usage?: { input_tokens?: number; output_tokens?: number };
    error?: { message?: string; code?: string };
    incomplete_details?: { reason?: string };
  };
  error?: { message?: string; code?: string };
  message?: string;
  code?: string;
}

/** Собирает итоговый ответ из SSE-потока Responses API. Частичный ответ при обрыве не возвращается — ошибка. */
export async function collectResponse(
  events: AsyncIterable<SseEvent>,
  fallbackModel: string,
  onText?: (delta: string) => void,
): Promise<Omit<ChatResponse, 'provider'>> {
  let deltaText = '';
  let itemText = '';
  const toolCalls: ToolCall[] = [];
  let usage = { promptTokens: 0, completionTokens: 0 };
  let model = fallbackModel;
  let completed = false;

  for await (const ev of events) {
    if (ev.data === '[DONE]') break;
    let json: ResponsesEvent;
    try {
      json = JSON.parse(ev.data) as ResponsesEvent;
    } catch {
      continue;
    }
    const type = json.type ?? ev.event;
    switch (type) {
      case 'response.output_text.delta':
        deltaText += json.delta ?? '';
        if (json.delta) onText?.(json.delta);
        break;
      case 'response.output_item.done': {
        const item = json.item;
        if (item?.type === 'message') {
          for (const c of item.content ?? []) if (c.type === 'output_text' && c.text) itemText += c.text;
        } else if (item?.type === 'function_call' && item.name) {
          toolCalls.push({
            id: item.call_id ?? `call_${toolCalls.length}`,
            name: item.name,
            arguments: safeJsonParse(item.arguments ?? ''),
          });
        }
        break;
      }
      case 'response.completed':
      case 'response.incomplete': {
        completed = true;
        const u = json.response?.usage;
        usage = { promptTokens: u?.input_tokens ?? 0, completionTokens: u?.output_tokens ?? 0 };
        model = json.response?.model ?? model;
        break;
      }
      case 'response.failed': {
        const e = json.response?.error;
        throw ProviderErrorFromBody(e?.code, e?.message);
      }
      case 'error':
        throw ProviderErrorFromBody(json.error?.code ?? json.code, json.error?.message ?? json.message);
      default:
        break;
    }
  }

  if (!completed) {
    throw new ProviderError('chatgpt', 'network', 'chatgpt: поток ответа оборвался до завершения');
  }
  const content = itemText || deltaText;
  if (!content.trim() && toolCalls.length === 0) {
    throw new ProviderError('chatgpt', 'empty', 'chatgpt: пустой ответ модели');
  }
  return { content, toolCalls, usage, model };
}

function ProviderErrorFromBody(code?: string, message?: string): ProviderError {
  const text = `chatgpt: ${code ? `${code} — ` : ''}${message ?? 'ошибка модели'}`;
  if (code === 'rate_limit_exceeded' || code === 'usage_limit_reached')
    return new ProviderError('chatgpt', 'rate_limit', text, 429);
  if (code === 'model_not_found') return new ProviderError('chatgpt', 'bad_request', text, 404);
  if (code === 'server_error') return new ProviderError('chatgpt', 'server', text, 500);
  return new ProviderError('chatgpt', 'bad_request', text);
}

export async function readResponsesBody(res: Response, fallbackModel: string, onText?: (delta: string) => void) {
  if (!res.body) throw new ProviderError('chatgpt', 'network', 'chatgpt: пустое тело ответа');
  return collectResponse(parseSse(res.body), fallbackModel, onText);
}
