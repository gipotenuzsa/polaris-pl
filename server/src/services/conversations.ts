import type { AppContext } from '../context.js';
import { json, queryOne } from '../db/types.js';
import type { ChatMessage, ImagePart, ToolCall } from '../providers/types.js';
import { notFound } from '../util/errors.js';

export type ConversationKind = 'chat' | 'task' | 'summary';
export type MessageRole = 'user' | 'assistant' | 'tool' | 'system';
export type MessageStatus = 'ok' | 'error' | 'pending' | 'rejected';

interface ConversationRow {
  id: string;
  title: string;
  kind: ConversationKind;
  created_at: Date;
  updated_at: Date;
}

export interface MessageRow {
  id: string;
  seq: number;
  conversation_id: string;
  role: MessageRole;
  content: string;
  tool_calls: ToolCall[] | null;
  tool_call_id: string | null;
  tool_name: string | null;
  status: MessageStatus;
  approval_id: string | null;
  provider: string | null;
  model: string | null;
  created_at: Date;
}

export interface ConversationDto {
  id: string;
  title: string;
  kind: ConversationKind;
  createdAt: string;
  updatedAt: string;
}

export interface AttachmentMeta {
  id: string;
  name: string;
  mime: string;
}

export const IMAGE_MIMES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'] as const;

export interface MessageDto {
  id: string;
  seq: number;
  conversationId: string;
  role: MessageRole;
  content: string;
  toolCalls?: { id: string; name: string; arguments: Record<string, unknown> }[];
  toolCallId?: string;
  toolName?: string;
  status: MessageStatus;
  approvalId?: string;
  provider?: string;
  model?: string;
  attachments?: AttachmentMeta[];
  createdAt: string;
}

const iso = (d: Date | string) => new Date(d).toISOString();

export const toConversationDto = (r: ConversationRow): ConversationDto => ({
  id: r.id,
  title: r.title,
  kind: r.kind,
  createdAt: iso(r.created_at),
  updatedAt: iso(r.updated_at),
});

export const toMessageDto = (r: MessageRow, attachments?: AttachmentMeta[]): MessageDto => ({
  id: r.id,
  seq: r.seq,
  conversationId: r.conversation_id,
  role: r.role,
  content: r.content,
  toolCalls: r.tool_calls?.map((c) => ({ id: c.id, name: c.name, arguments: c.arguments })),
  toolCallId: r.tool_call_id ?? undefined,
  toolName: r.tool_name ?? undefined,
  status: r.status,
  approvalId: r.approval_id ?? undefined,
  provider: r.provider ?? undefined,
  model: r.model ?? undefined,
  attachments: attachments?.length ? attachments : undefined,
  createdAt: iso(r.created_at),
});

/** Строки БД → сообщения для модели. Незавершённые (pending) вызовы сюда попадать не должны. */
export function rowsToChat(
  rows: MessageRow[],
  att: { images?: Map<string, ImagePart[]>; meta?: Map<string, AttachmentMeta[]> } = {},
): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (const r of rows) {
    if (r.role === 'user') {
      const images = att.images?.get(r.id);
      // Старые вложения в контекст не отправляем (дорого) — модель видит только пометку о них.
      const skipped = images ? [] : (att.meta?.get(r.id) ?? []);
      const note = skipped.length ? `\n[Прикреплено изображение: ${skipped.map((a) => a.name).join(', ')}]` : '';
      out.push({ role: 'user', content: r.content + note, ...(images?.length ? { images } : {}) });
    } else if (r.role === 'system') out.push({ role: 'system', content: r.content });
    else if (r.role === 'assistant') {
      out.push({ role: 'assistant', content: r.content, ...(r.tool_calls?.length ? { toolCalls: r.tool_calls } : {}) });
    } else {
      out.push({ role: 'tool', toolCallId: r.tool_call_id ?? '', name: r.tool_name ?? '', content: r.content });
    }
  }
  return out;
}

export interface NewMessage {
  conversationId: string;
  role: MessageRole;
  content?: string;
  toolCalls?: ToolCall[];
  toolCallId?: string;
  toolName?: string;
  status?: MessageStatus;
  approvalId?: string;
  provider?: string;
  model?: string;
}

export class ConversationService {
  constructor(private readonly ctx: AppContext) {}

  async create(title = 'Новый чат', kind: ConversationKind = 'chat'): Promise<ConversationDto> {
    const rows = await this.ctx.db.query<ConversationRow>(
      'insert into conversations (title, kind) values ($1, $2) returning *',
      [title.slice(0, 200), kind],
    );
    return toConversationDto(rows[0]!);
  }

  async list(kind: ConversationKind = 'chat', limit = 100): Promise<ConversationDto[]> {
    const rows = await this.ctx.db.query<ConversationRow>(
      'select * from conversations where kind = $1 order by updated_at desc limit $2',
      [kind, limit],
    );
    return rows.map(toConversationDto);
  }

  async get(id: string): Promise<ConversationDto> {
    const row = await queryOne<ConversationRow>(this.ctx.db, 'select * from conversations where id = $1', [id]);
    if (!row) throw notFound('Чат не найден');
    return toConversationDto(row);
  }

  async rename(id: string, title: string): Promise<void> {
    await this.ctx.db.query('update conversations set title = $2, updated_at = now() where id = $1', [
      id,
      title.slice(0, 200),
    ]);
  }

  async remove(id: string): Promise<void> {
    await this.ctx.db.query('delete from conversations where id = $1', [id]);
  }

  async messages(conversationId: string, afterSeq = 0, limit = 500): Promise<MessageRow[]> {
    const rows = await this.ctx.db.query<MessageRow>(
      `select * from (
         select * from messages where conversation_id = $1 and seq > $2 order by seq desc limit $3
       ) t order by seq asc`,
      [conversationId, afterSeq, limit],
    );
    return rows;
  }

  async add(m: NewMessage): Promise<MessageRow> {
    const rows = await this.ctx.db.query<MessageRow>(
      `insert into messages
         (conversation_id, role, content, tool_calls, tool_call_id, tool_name, status, approval_id, provider, model)
       values ($1, $2, $3, $4::jsonb, $5, $6, $7, $8, $9, $10) returning *`,
      [
        m.conversationId,
        m.role,
        m.content ?? '',
        json(m.toolCalls?.length ? m.toolCalls : null),
        m.toolCallId ?? null,
        m.toolName ?? null,
        m.status ?? 'ok',
        m.approvalId ?? null,
        m.provider ?? null,
        m.model ?? null,
      ],
    );
    await this.ctx.db.query('update conversations set updated_at = now() where id = $1', [m.conversationId]);
    return rows[0]!;
  }

  // ── Вложения ───────────────────────────────────────────────────────────────

  async createAttachment(a: { name: string; mime: string; data: string }): Promise<AttachmentMeta> {
    const rows = await this.ctx.db.query<AttachmentMeta>(
      'insert into attachments (name, mime, data_b64) values ($1, $2, $3) returning id, name, mime',
      [a.name.slice(0, 200), a.mime, a.data],
    );
    return rows[0]!;
  }

  async getAttachment(id: string): Promise<{ mime: string; data: string } | undefined> {
    return queryOne<{ mime: string; data: string }>(
      this.ctx.db,
      'select mime, data_b64 as data from attachments where id = $1',
      [id],
    );
  }

  /** Привязывает загруженные вложения к сообщению (только свободные — чужие не перехватить). */
  async attach(ids: string[], messageId: string): Promise<void> {
    if (!ids.length) return;
    await this.ctx.db.query(
      'update attachments set message_id = $2 where id = any($1::uuid[]) and message_id is null',
      [ids, messageId],
    );
  }

  async attachmentMeta(messageIds: string[]): Promise<Map<string, AttachmentMeta[]>> {
    const out = new Map<string, AttachmentMeta[]>();
    if (!messageIds.length) return out;
    const rows = await this.ctx.db.query<AttachmentMeta & { message_id: string }>(
      'select id, name, mime, message_id from attachments where message_id = any($1::uuid[]) order by created_at',
      [messageIds],
    );
    for (const r of rows) {
      out.set(r.message_id, [...(out.get(r.message_id) ?? []), { id: r.id, name: r.name, mime: r.mime }]);
    }
    return out;
  }

  async attachmentImages(messageIds: string[]): Promise<Map<string, ImagePart[]>> {
    const out = new Map<string, ImagePart[]>();
    if (!messageIds.length) return out;
    const rows = await this.ctx.db.query<{ message_id: string; mime: string; data: string }>(
      'select message_id, mime, data_b64 as data from attachments where message_id = any($1::uuid[]) order by created_at',
      [messageIds],
    );
    for (const r of rows) out.set(r.message_id, [...(out.get(r.message_id) ?? []), { mime: r.mime, data: r.data }]);
    return out;
  }

  /** Сообщения → DTO для клиента (с метаданными вложений). */
  async toDtos(rows: MessageRow[]): Promise<MessageDto[]> {
    const meta = await this.attachmentMeta(rows.filter((r) => r.role === 'user').map((r) => r.id));
    return rows.map((r) => toMessageDto(r, meta.get(r.id)));
  }

  /** Завершает ожидавший подтверждения вызов инструмента: подставляет результат на его место. */
  async resolveToolMessage(
    conversationId: string,
    toolCallId: string,
    result: { content: string; status: MessageStatus },
  ): Promise<void> {
    await this.ctx.db.query(
      `update messages set content = $3, status = $4
        where conversation_id = $1 and tool_call_id = $2 and role = 'tool' and status = 'pending'`,
      [conversationId, toolCallId, result.content, result.status],
    );
    await this.ctx.db.query('update conversations set updated_at = now() where id = $1', [conversationId]);
  }

  async pendingToolCount(conversationId: string): Promise<number> {
    const row = await queryOne<{ n: number }>(
      this.ctx.db,
      `select count(*)::int as n from messages where conversation_id = $1 and role = 'tool' and status = 'pending'`,
      [conversationId],
    );
    return row?.n ?? 0;
  }

  /**
   * После сбоя (перезапуск посреди выполнения) у последнего ответа ассистента могут остаться вызовы без результата —
   * модель такой диалог не примет. Достраиваем недостающие результаты как ошибку.
   */
  async repairDanglingToolCalls(conversationId: string): Promise<number> {
    const rows = await this.messages(conversationId, 0, 400);
    let lastAssistantIdx = -1;
    for (let i = rows.length - 1; i >= 0; i--) {
      if (rows[i]!.role === 'assistant') {
        lastAssistantIdx = i;
        break;
      }
    }
    const last = rows[lastAssistantIdx];
    if (!last?.tool_calls?.length) return 0;
    const answered = new Set(
      rows
        .slice(lastAssistantIdx + 1)
        .filter((r) => r.role === 'tool')
        .map((r) => r.tool_call_id),
    );
    let fixed = 0;
    for (const call of last.tool_calls) {
      if (answered.has(call.id)) continue;
      await this.add({
        conversationId,
        role: 'tool',
        toolCallId: call.id,
        toolName: call.name,
        content: 'Вызов прерван (перезапуск сервера). Повторите при необходимости.',
        status: 'error',
      });
      fixed++;
    }
    return fixed;
  }
}
