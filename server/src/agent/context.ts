import type { ChatMessage, ImagePart } from '../providers/types.js';
import { rowsToChat, type AttachmentMeta, type MessageRow } from '../services/conversations.js';

const CHARS_PER_TOKEN = 3.5;
/** Старые результаты инструментов усекаются: они нужны модели меньше всего и дороже всего. */
const OLD_TOOL_RESULT_CHARS = 1500;
const RECENT_FULL = 6;
const TOKENS_PER_IMAGE = 800;

export function estimateTokens(m: ChatMessage): number {
  const base = m.content.length + (m.role === 'assistant' && m.toolCalls ? JSON.stringify(m.toolCalls).length : 0);
  const images = m.role === 'user' ? (m.images?.length ?? 0) * TOKENS_PER_IMAGE : 0;
  return Math.ceil(base / CHARS_PER_TOKEN) + 4 + images;
}

/**
 * Краткосрочная память = окно последних сообщений чата в пределах лимита токенов.
 * Окно не начинается с «осиротевшего» результата инструмента или с реплики ассистента.
 */
export function buildMessages(
  system: string,
  rows: MessageRow[],
  maxTokens: number,
  att: { images?: Map<string, ImagePart[]>; meta?: Map<string, AttachmentMeta[]> } = {},
): ChatMessage[] {
  const all = rowsToChat(rows, att).map((m, i, arr) =>
    m.role === 'tool' && i < arr.length - RECENT_FULL && m.content.length > OLD_TOOL_RESULT_CHARS
      ? { ...m, content: `${m.content.slice(0, OLD_TOOL_RESULT_CHARS)}\n… [усечено]` }
      : m,
  );

  let total = Math.ceil(system.length / CHARS_PER_TOKEN);
  const kept: ChatMessage[] = [];
  for (let i = all.length - 1; i >= 0; i--) {
    const m = all[i]!;
    const t = estimateTokens(m);
    if (total + t > maxTokens && kept.length > 0) break;
    kept.push(m);
    total += t;
  }
  kept.reverse();

  while (kept.length > 0 && kept[0]!.role !== 'user') kept.shift();
  if (kept.length === 0) {
    // Окно целиком состояло из ответов ассистента/инструментов: берём всё с последней реплики пользователя.
    let lastUser = -1;
    for (let i = all.length - 1; i >= 0; i--) {
      if (all[i]!.role === 'user') {
        lastUser = i;
        break;
      }
    }
    kept.push(...(lastUser >= 0 ? all.slice(lastUser) : all));
  }
  return [{ role: 'system', content: system }, ...kept];
}
