import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { parse } from '../auth/auth.js';
import type { AppContext } from '../context.js';
import { IMAGE_MIMES } from '../services/conversations.js';
import { conflict, notFound } from '../util/errors.js';

const idParams = z.object({ id: z.string().uuid() });
const MAX_ATTACHMENTS = 4;
const MAX_ATTACHMENT_BYTES = 8_000_000;

export function chatRoutes(app: FastifyInstance, ctx: AppContext): void {
  // Загрузка картинки (base64 в JSON); к сообщению привязывается при его отправке.
  app.post('/api/attachments', { bodyLimit: 12_000_000 }, async (req) => {
    const b = parse(
      z.object({
        name: z.string().trim().min(1).max(200),
        mime: z.enum(IMAGE_MIMES),
        data: z
          .string()
          .min(16)
          .max(11_500_000)
          .regex(/^[A-Za-z0-9+/]+=*$/, 'Ожидался base64'),
      }),
      req.body,
    );
    if (Math.floor((b.data.length * 3) / 4) > MAX_ATTACHMENT_BYTES) {
      throw conflict('Изображение слишком большое (максимум 8 МБ)', 'too_large');
    }
    return { attachment: await ctx.conversations.createAttachment(b) };
  });

  app.get('/api/attachments/:id', async (req, reply) => {
    const { id } = parse(idParams, req.params);
    const a = await ctx.conversations.getAttachment(id);
    if (!a) throw notFound('Вложение не найдено');
    return reply
      .header('content-type', a.mime)
      .header('cache-control', 'private, max-age=86400, immutable')
      .header('content-security-policy', "default-src 'none'; sandbox")
      .send(Buffer.from(a.data, 'base64'));
  });

  app.get('/api/conversations', async (req) => {
    const { kind } = parse(z.object({ kind: z.enum(['chat', 'summary', 'task']).default('chat') }), req.query);
    return { conversations: await ctx.conversations.list(kind) };
  });

  app.post('/api/conversations', async (req) => {
    const { title } = parse(z.object({ title: z.string().max(200).optional() }), req.body ?? {});
    return { conversation: await ctx.conversations.create(title || 'Новый чат') };
  });

  // Единый сквозной разговор — главный экран приложения.
  app.get('/api/main', async () => ({ conversation: await ctx.conversations.main() }));

  app.get('/api/conversations/:id', async (req) => {
    const { id } = parse(idParams, req.params);
    const { after, before, limit } = parse(
      z.object({
        after: z.coerce.number().int().min(0).default(0),
        before: z.coerce.number().int().min(1).optional(),
        limit: z.coerce.number().int().min(1).max(500).default(500),
      }),
      req.query,
    );
    const conversation = await ctx.conversations.get(id);
    ctx.runs.touchViewed(id);
    const rows = await ctx.conversations.messages(id, after, limit, before);
    return {
      conversation,
      messages: await ctx.conversations.toDtos(rows),
      running: ctx.runs.isRunning(id),
      live: ctx.runs.isRunning(id) ? ctx.runs.liveText(id) : '',
      pendingApprovals: (await ctx.approvals.list('pending')).filter((a) => a.conversationId === id),
    };
  });

  app.post('/api/conversations/:id/stop', async (req) => {
    const { id } = parse(idParams, req.params);
    await ctx.conversations.get(id);
    return { stopped: ctx.runs.stop(id) };
  });

  /** Повторить ответ на последнее сообщение пользователя. */
  app.post('/api/conversations/:id/regenerate', async (req, reply) => {
    const { id } = parse(idParams, req.params);
    await ctx.conversations.get(id);
    if (ctx.runs.isRunning(id)) throw conflict('Агент ещё отвечает', 'busy');
    if ((await ctx.conversations.pendingToolCount(id)) > 0) throw conflict('Сначала решите по ожидающему действию', 'pending_approval');
    const last = await ctx.conversations.rewind(id, true);
    if (!last) throw conflict('Нечего повторять', 'empty');
    ctx.runs.startChat(id);
    reply.code(202);
    return { running: true };
  });

  /** Изменить последнее сообщение: убирает его вместе с ответом и возвращает текст для правки. */
  app.post('/api/conversations/:id/rewind', async (req) => {
    const { id } = parse(idParams, req.params);
    await ctx.conversations.get(id);
    if (ctx.runs.isRunning(id)) throw conflict('Агент ещё отвечает', 'busy');
    if ((await ctx.conversations.pendingToolCount(id)) > 0) throw conflict('Сначала решите по ожидающему действию', 'pending_approval');
    const last = await ctx.conversations.rewind(id, false);
    if (!last) throw conflict('Нечего менять', 'empty');
    return { content: last.content };
  });

  /** Поиск по ленте: реплики пользователя и Polaris со сниппетом вокруг совпадения. */
  app.get('/api/conversations/:id/search', async (req) => {
    const { id } = parse(idParams, req.params);
    const { q } = parse(z.object({ q: z.string().trim().min(2).max(200) }), req.query);
    await ctx.conversations.get(id);
    const rows = await ctx.conversations.searchMessages(id, q, 30);
    return {
      results: rows.map((r) => {
        const flat = r.content.replace(/\s+/g, ' ').trim();
        const at = Math.max(0, flat.toLowerCase().indexOf(q.toLowerCase()));
        const from = Math.max(0, at - 60);
        return {
          id: r.id,
          seq: r.seq,
          role: r.role,
          createdAt: new Date(r.created_at).toISOString(),
          snippet: `${from > 0 ? '…' : ''}${flat.slice(from, from + 200)}${flat.length > from + 200 ? '…' : ''}`,
        };
      }),
    };
  });

  app.patch('/api/conversations/:id', async (req) => {
    const { id } = parse(idParams, req.params);
    const { title, pinned } = parse(
      z
        .object({ title: z.string().trim().min(1).max(200).optional(), pinned: z.boolean().optional() })
        .refine((b) => b.title !== undefined || b.pinned !== undefined, { message: 'Нечего менять' }),
      req.body,
    );
    await ctx.conversations.get(id);
    if (title !== undefined) await ctx.conversations.rename(id, title);
    if (pinned !== undefined) await ctx.conversations.setPinned(id, pinned);
    return { ok: true };
  });

  app.delete('/api/conversations/:id', async (req) => {
    const { id } = parse(idParams, req.params);
    await ctx.conversations.get(id);
    await ctx.conversations.remove(id);
    return { ok: true };
  });

  app.post('/api/conversations/:id/messages', async (req, reply) => {
    const { id } = parse(idParams, req.params);
    const { content, attachmentIds } = parse(
      z
        .object({
          content: z.string().trim().max(20_000).default(''),
          attachmentIds: z.array(z.string().uuid()).max(MAX_ATTACHMENTS).default([]),
        })
        .refine((b) => b.content.length > 0 || b.attachmentIds.length > 0, { message: 'Пустое сообщение' }),
      req.body,
    );
    const conv = await ctx.conversations.get(id);
    if (ctx.runs.isRunning(id)) throw conflict('Агент ещё отвечает на предыдущее сообщение', 'busy');
    if ((await ctx.conversations.pendingToolCount(id)) > 0) {
      throw conflict('Сначала подтвердите или отклоните ожидающее действие', 'pending_approval');
    }
    const message = await ctx.conversations.add({ conversationId: id, role: 'user', content });
    await ctx.conversations.attach(attachmentIds, message.id);
    if (conv.title === 'Новый чат') {
      await ctx.conversations.rename(id, content.replace(/\s+/g, ' ').slice(0, 60) || 'Изображение');
    }
    ctx.runs.touchViewed(id);
    ctx.runs.startChat(id);
    reply.code(202);
    return { message: (await ctx.conversations.toDtos([message]))[0], running: true };
  });
}
