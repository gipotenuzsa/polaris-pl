import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fastifyStatic from '@fastify/static';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.js';
import { safeEqual } from '../crypto/secrets.js';
import { HttpError } from '../util/errors.js';

export const VERSION = '0.1.0';

export function systemRoutes(app: FastifyInstance, ctx: AppContext): void {
  const startedAt = Date.now();

  /** Не раскрывает внутреннее состояние: только «жив». Его же пингует pg_cron. */
  app.get('/health', async () => ({ ok: true }));

  app.get('/api/status', async () => ({
    version: VERSION,
    uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
    providers: await ctx.providers.list(),
    tools: ctx.tools.all().map((t) => t.name),
    scheduler: { enabled: ctx.config.scheduler.enabled, activeRuns: ctx.runs.activeCount() },
    files: ctx.config.supabase.url ? 'supabase' : 'local',
    unreadNotifications: await ctx.notifications.unreadCount(),
    pendingApprovals: await ctx.approvals.pendingCount(),
    timezone: ctx.config.timezone,
  }));

  /** Вызывается pg_cron раз в минуту: будит сервер и запускает просроченное. */
  app.post('/internal/tick', async (req) => {
    const secret = ctx.config.cronSecret;
    const given = String(req.headers['x-cron-secret'] ?? '');
    if (!secret || !given || !safeEqual(secret, given)) throw new HttpError(401, 'Нет доступа', 'unauthorized');
    return ctx.scheduler.tick();
  });
}

/** Отдаёт веб-версию клиента (PWA), собранную `expo export --platform web`. */
export async function registerWeb(app: FastifyInstance, ctx: AppContext): Promise<boolean> {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const dir = path.resolve(ctx.config.webDir ?? path.join(here, '..', '..', 'public'));
  if (!existsSync(path.join(dir, 'index.html'))) return false;

  // wildcard: true — файлы ищутся при каждом запросе, а не фиксируются при старте (пересборка клиента не требует перезапуска)
  await app.register(fastifyStatic, { root: dir, index: ['index.html'] });
  app.setNotFoundHandler(async (req, reply) => {
    const url = req.url.split('?')[0] ?? '';
    if (req.method === 'GET' && !url.startsWith('/api/') && !url.startsWith('/internal/')) {
      return reply.sendFile('index.html');
    }
    return reply.code(404).send({ error: 'not_found', message: 'Не найдено' });
  });
  return true;
}
