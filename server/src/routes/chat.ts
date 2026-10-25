import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { parse } from '../auth/auth.js';
import type { AppContext } from '../context.js';
import { toMessageDto } from '../services/conversations.js';
import { conflict } from '../util/errors.js';

const idParams = z.object({ id: z.string().uuid() });

export function chatRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/api/conversations', async (req) => {
    const { kind } = parse(z.object({ kind: z.enum(['chat', 'summary', 'task']).default('chat') }), req.query);
    return { conversations: await ctx.conversations.list(kind) };
  });

  app.post('/api/conversations', async (req) => {
    const { title } = parse(z.object({ title: z.string().max(200).optional() }), req.body ?? {});
    return { conversation: await ctx.conversations.create(title || 'Новый чат') };
  });

  app.get('/api/conversations/:id', async (req) => {
    const { id } = parse(idParams, req.params);
    const { after } = parse(z.object({ after: z.coerce.number().int().min(0).default(0) }), req.query);
    const conversation = await ctx.conversations.get(id);
    const rows = await ctx.conversations.messages(id, after);
    return {
      conversation,
      messages: rows.map(toMessageDto),
      running: ctx.runs.isRunning(id),
      pendingApprovals: (await ctx.approvals.list('pending')).filter((a) => a.conversationId === id),
    };
  });

  app.patch('/api/conversations/:id', async (req) => {
    const { id } = parse(idParams, req.params);
    const { title } = parse(z.object({ title: z.string().min(1).max(200) }), req.body);
    await ctx.conversations.get(id);
    await ctx.conversations.rename(id, title);
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
    const { content } = parse(z.object({ content: z.string().trim().min(1).max(20_000) }), req.body);
    const conv = await ctx.conversations.get(id);
    if (ctx.runs.isRunning(id)) throw conflict('Агент ещё отвечает на предыдущее сообщение', 'busy');
    if ((await ctx.conversations.pendingToolCount(id)) > 0) {
      throw conflict('Сначала подтвердите или отклоните ожидающее действие', 'pending_approval');
    }
    const message = await ctx.conversations.add({ conversationId: id, role: 'user', content });
    if (conv.title === 'Новый чат') await ctx.conversations.rename(id, content.replace(/\s+/g, ' ').slice(0, 60));
    ctx.runs.startChat(id);
    reply.code(202);
    return { message: toMessageDto(message), running: true };
  });
}
