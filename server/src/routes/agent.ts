import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { parse } from '../auth/auth.js';
import type { AppContext } from '../context.js';
import { agentSchema, budgetSchema, chatgptSettingsSchema, morningSchema } from '../services/settings.js';
import { scheduleSchema } from '../tools/tasksTools.js';

const idParams = z.object({ id: z.string().uuid() });

export function agentRoutes(app: FastifyInstance, ctx: AppContext): void {
  // ── Задачи ────────────────────────────────────────────────────────────────
  app.get('/api/tasks', async () => ({ items: await ctx.tasks.list() }));

  app.post('/api/tasks', async (req) => {
    const b = parse(
      z.object({
        goal: z.string().trim().min(3).max(2000),
        schedule: scheduleSchema.nullable().optional(),
        budget: z
          .object({ maxTokens: z.number().int().min(1000).optional(), maxUsd: z.number().min(0.001).optional() })
          .nullable()
          .optional(),
      }),
      req.body,
    );
    return { item: await ctx.tasks.create(b) };
  });

  app.get('/api/tasks/:id', async (req) => ctx.tasks.detail(parse(idParams, req.params).id));
  app.post('/api/tasks/:id/cancel', async (req) => ({ item: await ctx.tasks.cancel(parse(idParams, req.params).id) }));
  app.post('/api/tasks/:id/run', async (req) => ({ item: await ctx.tasks.runNow(parse(idParams, req.params).id) }));
  app.delete('/api/tasks/:id', async (req) => {
    await ctx.tasks.remove(parse(idParams, req.params).id);
    return { ok: true };
  });

  // ── Подтверждения ─────────────────────────────────────────────────────────
  app.get('/api/approvals', async (req) => {
    const { status } = parse(z.object({ status: z.enum(['pending', 'approved', 'rejected']).optional() }), req.query);
    return { items: await ctx.approvals.list(status) };
  });

  app.post('/api/approvals/:id/approve', async (req) => ({
    item: await ctx.approvals.resolve(parse(idParams, req.params).id, 'approve'),
  }));

  app.post('/api/approvals/:id/reject', async (req) => {
    const { note } = parse(z.object({ note: z.string().max(500).optional() }), req.body ?? {});
    return { item: await ctx.approvals.resolve(parse(idParams, req.params).id, 'reject', note) };
  });

  // ── Бюджет ────────────────────────────────────────────────────────────────
  app.get('/api/budget', async () => ctx.budget.summary());
  app.put('/api/budget', async (req) => {
    const limits = parse(budgetSchema, req.body);
    await ctx.settings.set('budget', limits);
    return ctx.budget.summary();
  });

  // ── Настройки агента и сводки ─────────────────────────────────────────────
  app.get('/api/settings', async () => ({
    morning: await ctx.settings.getMorning(),
    agent: await ctx.settings.getAgent(),
    timezone: ctx.config.timezone,
  }));

  app.put('/api/settings/morning', async (req) => {
    const b = parse(morningSchema, req.body);
    const cur = await ctx.settings.getMorning();
    await ctx.settings.set('morning', { ...b, lastRunDate: cur.lastRunDate });
    return { morning: await ctx.settings.getMorning() };
  });

  app.put('/api/settings/agent', async (req) => {
    await ctx.settings.set('agent', parse(agentSchema, req.body));
    return { agent: await ctx.settings.getAgent() };
  });

  app.post('/api/morning/run', async () => ctx.morning.generate());

  // ── Провайдеры моделей ────────────────────────────────────────────────────
  app.get('/api/providers', async () => ({
    providers: await ctx.providers.list(),
    chatgpt: await ctx.chatgpt.status(),
  }));

  app.put('/api/providers/chatgpt/settings', async (req) => {
    const b = parse(chatgptSettingsSchema.partial(), req.body);
    if (b.model !== undefined) await ctx.chatgpt.setModel(b.model);
    if (b.enabled !== undefined) await ctx.chatgpt.setEnabled(b.enabled);
    return ctx.chatgpt.status();
  });

  app.post('/api/providers/chatgpt/connect', async () => ctx.chatgpt.startFlow());

  app.post('/api/providers/chatgpt/callback', async (req) => {
    const { url } = parse(z.object({ url: z.string().min(1).max(4000) }), req.body);
    await ctx.chatgpt.completeFlow(url);
    // Если других провайдеров нет, вход в ChatGPT — явное намерение им пользоваться: включаем сразу.
    // При наличии ключей других провайдеров ChatGPT остаётся запасным и включается переключателем.
    const others = (await ctx.providers.list()).some((p) => p.id !== 'chatgpt' && p.available);
    if (!others) await ctx.chatgpt.setEnabled(true);
    return ctx.chatgpt.status();
  });

  app.post('/api/providers/chatgpt/check', async () => ctx.chatgpt.check());

  app.post('/api/providers/chatgpt/disconnect', async () => {
    await ctx.chatgpt.disconnect();
    return ctx.chatgpt.status();
  });
}
