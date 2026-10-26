import fastifyCookie from '@fastify/cookie';
import fastifyRateLimit from '@fastify/rate-limit';
import Fastify, { type FastifyInstance } from 'fastify';
import type { Logger as PinoLogger } from 'pino';
import { ZodError } from 'zod';
import { registerAuth } from './auth/auth.js';
import type { AppContext } from './context.js';
import { OAuthError } from './providers/chatgpt/oauth.js';
import { agentRoutes } from './routes/agent.js';
import { backupRoutes } from './routes/backup.js';
import { chatRoutes } from './routes/chat.js';
import { dataRoutes } from './routes/data.js';
import { pushRoutes } from './routes/push.js';
import { registerWeb, systemRoutes } from './routes/system.js';
import { HttpError } from './util/errors.js';

export async function buildApp(ctx: AppContext, opts: { logger?: PinoLogger } = {}): Promise<FastifyInstance> {
  const app = Fastify({
    ...(opts.logger ? { loggerInstance: opts.logger } : { logger: false }),
    trustProxy: true, // за прокси Render реальный IP клиента нужен для лимитов
    bodyLimit: 2_000_000,
  }) as unknown as FastifyInstance; // pino-логгер меняет generic-параметр типа; для маршрутов он не нужен

  // CORS нужен только веб-клиенту в режиме разработки (другой порт) — он ходит с Bearer-токеном, без cookie.
  if (ctx.config.corsOrigins.length > 0) {
    const allowed = new Set(ctx.config.corsOrigins);
    app.addHook('onRequest', async (req, reply) => {
      const origin = req.headers.origin;
      if (!origin || !allowed.has(origin)) return;
      reply.header('access-control-allow-origin', origin);
      reply.header('vary', 'Origin');
      reply.header('access-control-allow-headers', 'authorization, content-type');
      reply.header('access-control-allow-methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
      reply.header('access-control-max-age', '600');
      if (req.method === 'OPTIONS') return reply.code(204).send();
    });
  }

  await app.register(fastifyCookie);
  await app.register(fastifyRateLimit, { global: true, max: 300, timeWindow: '1 minute' });

  app.addHook('onSend', async (req, reply, payload) => {
    reply.header('x-content-type-options', 'nosniff');
    reply.header('referrer-policy', 'no-referrer');
    reply.header('x-frame-options', 'DENY');
    reply.header('content-security-policy', "frame-ancestors 'none'");
    if (ctx.config.cookieSecure) reply.header('strict-transport-security', 'max-age=15552000');
    if (req.url.startsWith('/api/') || req.url.startsWith('/internal/')) reply.header('cache-control', 'no-store');
    return payload;
  });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof HttpError) {
      return reply.code(err.statusCode).send({ error: err.code ?? 'error', message: err.message });
    }
    if (err instanceof ZodError) {
      const message = err.issues.map((i) => `${i.path.join('.') || 'тело'}: ${i.message}`).join('; ');
      return reply.code(400).send({ error: 'bad_request', message });
    }
    if (err instanceof OAuthError) {
      return reply.code(400).send({ error: 'oauth', message: err.message });
    }
    const status = (err as { statusCode?: number }).statusCode;
    if (typeof status === 'number' && status >= 400 && status < 500) {
      return reply.code(status).send({
        error: status === 429 ? 'rate_limited' : 'bad_request',
        message: status === 429 ? 'Слишком много запросов, подождите' : (err as Error).message,
      });
    }
    req.log.error({ err }, 'Необработанная ошибка');
    return reply.code(500).send({ error: 'internal', message: 'Внутренняя ошибка сервера' });
  });

  registerAuth(app, ctx);
  systemRoutes(app, ctx);
  chatRoutes(app, ctx);
  dataRoutes(app, ctx);
  agentRoutes(app, ctx);
  pushRoutes(app, ctx);
  backupRoutes(app, ctx);

  const web = await registerWeb(app, ctx);
  if (!web) {
    app.setNotFoundHandler((_req, reply) => reply.code(404).send({ error: 'not_found', message: 'Не найдено' }));
  }
  return app;
}
