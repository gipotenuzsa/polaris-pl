import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { parse } from '../auth/auth.js';
import type { AppContext } from '../context.js';
import { conflict } from '../util/errors.js';

const subscription = z.object({
  endpoint: z.string().url().max(2000),
  keys: z.object({ p256dh: z.string().min(10).max(200), auth: z.string().min(4).max(100) }),
});

export function pushRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/api/push/status', async () => ({
    publicKey: await ctx.push.publicKey(),
    subscriptions: await ctx.push.count(),
  }));

  app.post('/api/push/subscribe', async (req) => {
    const sub = parse(subscription, req.body);
    await ctx.push.subscribe(sub, String(req.headers['user-agent'] ?? ''));
    return { ok: true, subscriptions: await ctx.push.count() };
  });

  app.post('/api/push/unsubscribe', async (req) => {
    const { endpoint } = parse(z.object({ endpoint: z.string().min(1).max(2000) }), req.body);
    await ctx.push.unsubscribe(endpoint);
    return { ok: true, subscriptions: await ctx.push.count() };
  });

  app.post('/api/push/test', async () => {
    if ((await ctx.push.count()) === 0)
      throw conflict('Нет подписанных устройств: сначала включите уведомления', 'no_subscriptions');
    return ctx.push.send({
      title: 'Polaris',
      body: 'Проверка уведомлений: если вы это видите, всё работает ✦',
      url: '/inbox',
      tag: 'push-test',
    });
  });
}
