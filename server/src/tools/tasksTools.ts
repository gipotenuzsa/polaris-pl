import { z } from 'zod';
import { resolveId, shortId } from './util.js';
import { defineTool, type AnyTool } from './types.js';

export const scheduleSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('once'), at: z.string().describe('ISO 8601; без пояса — по времени пользователя') }),
  z.object({ type: z.literal('interval'), everyMinutes: z.number().int().min(5).max(525_600) }),
  z.object({ type: z.literal('daily'), time: z.string().regex(/^\d{1,2}:\d{2}$/), timezone: z.string().optional() }),
]);

export function tasksTools(): AnyTool[] {
  return [
    defineTool({
      name: 'task_create',
      description:
        'Создаёт фоновую задачу: агент выполнит её сам, без участия пользователя, и пришлёт результат. ' +
        'goal — самодостаточная формулировка цели. schedule необязателен: без него задача стартует сразу.',
      schema: z.object({ goal: z.string().min(5).max(2000), schedule: scheduleSchema.optional() }),
      describe: (a) => `Фоновая задача: ${a.goal}`,
      async execute(a, { app }) {
        const task = await app.tasks.create({ goal: a.goal, schedule: a.schedule ?? null });
        return {
          content: `Задача создана (id: ${shortId(task.id)}), статус: ${task.status}. Результат придёт уведомлением.`,
          summary: `Создана задача: ${a.goal}`,
          undo: { kind: 'task.create', data: { id: task.id } },
        };
      },
    }),
    defineTool({
      name: 'task_list',
      description: 'Список фоновых задач и их статусы.',
      schema: z.object({}),
      describe: () => 'Список задач',
      async execute(_a, { app }) {
        const tasks = await app.tasks.list();
        if (!tasks.length) return { content: 'Задач нет.', summary: 'Задачи: 0' };
        return {
          content: tasks
            .slice(0, 30)
            .map(
              (t) =>
                `- ${shortId(t.id)} | ${t.status} | ${t.goal.slice(0, 100)}${t.lastResult ? ` | итог: ${t.lastResult.slice(0, 100)}` : ''}`,
            )
            .join('\n'),
          summary: `Задачи: ${tasks.length}`,
        };
      },
    }),
    defineTool({
      name: 'task_cancel',
      description: 'Отменяет фоновую задачу по id.',
      schema: z.object({ id: z.string().min(4) }),
      describe: (a) => `Отменить задачу ${a.id}`,
      async execute(a, { app }) {
        const id = await resolveId(app, 'tasks', a.id);
        await app.tasks.cancel(id);
        return { content: 'Задача отменена.', summary: `Отменена задача ${shortId(id)}` };
      },
    }),
  ];
}
