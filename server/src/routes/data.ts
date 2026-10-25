import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { parse } from '../auth/auth.js';
import type { AppContext } from '../context.js';
import { toMemoryDto } from '../services/memory.js';
import { toNoteDto, toReminderDto } from '../services/notes.js';
import { normalizeUserPath } from '../storage/types.js';
import { badRequest, notFound } from '../util/errors.js';

const idParams = z.object({ id: z.string().uuid() });
const memoryKind = z.enum(['fact', 'preference']);

export function dataRoutes(app: FastifyInstance, ctx: AppContext): void {
  // ── Память ────────────────────────────────────────────────────────────────
  app.get('/api/memory', async (req) => {
    const { kind } = parse(z.object({ kind: memoryKind.optional() }), req.query);
    return { items: await ctx.memory.list(kind) };
  });

  app.post('/api/memory', async (req) => {
    const body = parse(z.object({ kind: memoryKind, content: z.string().trim().min(2).max(1000) }), req.body);
    const { row } = await ctx.memory.create({ ...body, source: 'user' });
    return { item: toMemoryDto(row) };
  });

  app.patch('/api/memory/:id', async (req) => {
    const { id } = parse(idParams, req.params);
    const patch = parse(
      z.object({ kind: memoryKind.optional(), content: z.string().trim().min(2).max(1000).optional() }),
      req.body,
    );
    return { item: toMemoryDto(await ctx.memory.update(id, patch)) };
  });

  app.delete('/api/memory/:id', async (req) => {
    const { id } = parse(idParams, req.params);
    await ctx.memory.remove(id);
    return { ok: true };
  });

  // ── Заметки ───────────────────────────────────────────────────────────────
  app.get('/api/notes', async (req) => {
    const { q } = parse(z.object({ q: z.string().max(200).optional() }), req.query);
    return { items: (await ctx.notes.list(q)).map(toNoteDto) };
  });

  app.post('/api/notes', async (req) => {
    const b = parse(
      z.object({ title: z.string().trim().min(1).max(200), body: z.string().max(50_000).default('') }),
      req.body,
    );
    return { item: toNoteDto(await ctx.notes.create(b.title, b.body)) };
  });

  app.patch('/api/notes/:id', async (req) => {
    const { id } = parse(idParams, req.params);
    const b = parse(
      z.object({ title: z.string().trim().min(1).max(200).optional(), body: z.string().max(50_000).optional() }),
      req.body,
    );
    return { item: toNoteDto(await ctx.notes.update(id, b)) };
  });

  app.delete('/api/notes/:id', async (req) => {
    const { id } = parse(idParams, req.params);
    await ctx.notes.remove(id);
    return { ok: true };
  });

  // ── Напоминания ───────────────────────────────────────────────────────────
  app.get('/api/reminders', async (req) => {
    const { status } = parse(z.object({ status: z.enum(['pending', 'fired', 'cancelled']).optional() }), req.query);
    return { items: (await ctx.reminders.list(status)).map(toReminderDto) };
  });

  app.post('/api/reminders', async (req) => {
    const b = parse(
      z.object({ text: z.string().trim().min(1).max(500), dueAt: z.string().datetime({ offset: true }) }),
      req.body,
    );
    const due = new Date(b.dueAt);
    if (due.getTime() <= ctx.clock().getTime()) throw badRequest('Время напоминания уже прошло');
    return { item: toReminderDto(await ctx.reminders.create(b.text, due)) };
  });

  app.delete('/api/reminders/:id', async (req) => {
    const { id } = parse(idParams, req.params);
    await ctx.reminders.get(id);
    await ctx.reminders.remove(id);
    return { ok: true };
  });

  // ── Уведомления ───────────────────────────────────────────────────────────
  app.get('/api/notifications', async (req) => {
    const { unread } = parse(z.object({ unread: z.coerce.boolean().optional() }), req.query);
    return {
      items: await ctx.notifications.list({ unreadOnly: unread }),
      unread: await ctx.notifications.unreadCount(),
    };
  });

  app.post('/api/notifications/read-all', async () => {
    await ctx.notifications.markAllRead();
    return { ok: true };
  });

  app.post('/api/notifications/:id/read', async (req) => {
    const { id } = parse(idParams, req.params);
    await ctx.notifications.markRead(id);
    return { ok: true };
  });

  // ── Журнал действий ───────────────────────────────────────────────────────
  app.get('/api/actions', async (req) => {
    const q = parse(
      z.object({ limit: z.coerce.number().int().min(1).max(500).default(100), tool: z.string().max(100).optional() }),
      req.query,
    );
    return { items: await ctx.actions.list(q) };
  });

  app.post('/api/actions/:id/undo', async (req) => {
    const { id } = parse(idParams, req.params);
    return ctx.actions.undo(id);
  });

  // ── Файлы (Supabase Storage) ──────────────────────────────────────────────
  app.get('/api/files', async (req) => {
    const { path } = parse(z.object({ path: z.string().max(500).optional() }), req.query);
    const prefix = path ? normalizeUserPath(path) : '';
    const entries = (await ctx.files.list(prefix)).filter((e) => !(prefix === '' && e.name.startsWith('_')));
    return { path: prefix, entries };
  });

  app.get('/api/files/content', async (req, reply) => {
    const { path } = parse(z.object({ path: z.string().min(1).max(500) }), req.query);
    const data = await ctx.files.read(normalizeUserPath(path));
    if (!data) throw notFound('Файл не найден');
    if (data.length > 2_000_000) throw badRequest('Файл слишком большой для просмотра');
    reply.header('content-type', 'text/plain; charset=utf-8').header('content-disposition', 'inline');
    return data.toString('utf8');
  });

  app.delete('/api/files', async (req) => {
    const { path } = parse(z.object({ path: z.string().min(1).max(500) }), req.query);
    const p = normalizeUserPath(path);
    if (!(await ctx.files.exists(p))) throw notFound('Файл не найден');
    await ctx.files.move(p, `_trash/${new Date().toISOString().replace(/[:.]/g, '-')}/${p}`);
    return { ok: true };
  });
}
