import { afterEach, describe, expect, it } from 'vitest';
import { createTestEnv, login, toolCall, waitFor, type TestEnv } from './helpers.js';

let env: TestEnv;
afterEach(async () => env?.close());

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

async function api(
  method: string,
  url: string,
  h: Record<string, string>,
  payload?: unknown,
): Promise<{ status: number; body: Json }> {
  const r = await env.app.inject({ method: method as 'GET', url, headers: h, payload: payload as object | undefined });
  return { status: r.statusCode, body: r.json() };
}
const status = async (id: string) => (await env.ctx.tasks.get(id)).status;

describe('фоновые задачи', () => {
  it('задача без расписания стартует сразу, выполняет шаги и присылает результат', async () => {
    env = await createTestEnv({
      script: (req, n) => {
        if (n === 1) {
          expect(req.tools!.map((t) => t.name)).not.toContain('task_create'); // задачи не плодят задачи
          expect(String(req.messages[0]!.content)).toContain('Режим фоновой задачи');
          return { toolCalls: [toolCall('get_time', {})] };
        }
        return { content: 'Итог: время получено, всё хорошо.' };
      },
    });
    const h = await login(env.app);
    const created = await api('POST', '/api/tasks', h, { goal: 'Узнай, который час, и доложи' });
    expect(created.status).toBe(200);
    const id = created.body.item.id as string;

    await waitFor(async () => (await status(id)) === 'done');
    const { task, steps } = (await api('GET', `/api/tasks/${id}`, h)).body as Json;
    expect(task).toMatchObject({ status: 'done', runCount: 1, lastResult: 'Итог: время получено, всё хорошо.' });
    expect(task.nextRunAt).toBeUndefined();
    expect(steps.map((s: Json) => s.type)).toEqual(['info', 'model', 'tool', 'model', 'result']);

    const notes = (await api('GET', '/api/notifications', h)).body.items as Json[];
    expect(notes[0]).toMatchObject({ kind: 'task_done', ref: { taskId: id } });

    // диалог задачи не засоряет список чатов
    expect((await api('GET', '/api/conversations', h)).body.conversations).toHaveLength(0);
    expect((await api('GET', '/api/conversations?kind=task', h)).body.conversations).toHaveLength(1);
    // бюджет считается и по фоновым задачам
    expect((await api('GET', '/api/budget', h)).body.daily.tokens).toBe(240);
  });

  it('запуск по расписанию: ждёт своего времени', async () => {
    let now = new Date('2026-06-01T10:00:00Z');
    env = await createTestEnv({ clock: () => now, script: () => ({ content: 'готово' }) });
    const h = await login(env.app);
    const id = (
      await api('POST', '/api/tasks', h, {
        goal: 'Отчёт позже',
        schedule: { type: 'once', at: '2026-06-01T12:00:00Z' },
      })
    ).body.item.id as string;
    expect((await api('GET', `/api/tasks/${id}`, h)).body.task.nextRunAt).toBe('2026-06-01T12:00:00.000Z');

    expect((await env.ctx.scheduler.tick()).tasksStarted).toBe(0);
    expect(await status(id)).toBe('scheduled');

    now = new Date('2026-06-01T12:00:01Z');
    expect((await env.ctx.scheduler.tick()).tasksStarted).toBe(1);
    await waitFor(async () => (await status(id)) === 'done');
  });

  it('повторяющаяся задача переносится на следующий запуск и помнит прошлый результат', async () => {
    let now = new Date('2026-06-01T08:00:00Z');
    env = await createTestEnv({ clock: () => now, script: (_r, n) => ({ content: `результат ${n}` }) });
    const h = await login(env.app);
    const id = (
      await api('POST', '/api/tasks', h, { goal: 'Следи за курсом', schedule: { type: 'interval', everyMinutes: 60 } })
    ).body.item.id as string;
    await waitFor(async () => (await env.ctx.tasks.get(id)).runCount === 1 && (await status(id)) === 'scheduled');
    let t = (await api('GET', `/api/tasks/${id}`, h)).body.task as Json;
    expect(t).toMatchObject({ lastResult: 'результат 1', nextRunAt: '2026-06-01T09:00:00.000Z' });

    now = new Date('2026-06-01T09:00:05Z');
    await env.ctx.scheduler.tick();
    await waitFor(async () => (await env.ctx.tasks.get(id)).runCount === 2 && (await status(id)) === 'scheduled');
    t = (await api('GET', `/api/tasks/${id}`, h)).body.task;
    expect(t.lastResult).toBe('результат 2');
    // второй запуск получил контекст прошлого
    const secondRun = env.provider.calls[1]!.messages.find((m) => m.role === 'user')!;
    expect(secondRun.content).toContain('результат 1');
  });

  it('действие с риском внутри задачи: пауза → подтверждение → продолжение', async () => {
    env = await createTestEnv({
      script: (_r, n) =>
        n === 1
          ? { toolCalls: [toolCall('file_delete', { path: 'old.log' }, 'del')] }
          : { content: 'Старый лог удалён.' },
    });
    await env.ctx.files.write('old.log', 'мусор');
    const h = await login(env.app);
    const id = (await api('POST', '/api/tasks', h, { goal: 'Удали old.log' })).body.item.id as string;

    await waitFor(async () => (await status(id)) === 'awaiting_approval');
    expect(await env.ctx.files.exists('old.log')).toBe(true);
    const [approval] = (await api('GET', '/api/approvals?status=pending', h)).body.items as Json[];
    expect(approval).toMatchObject({ action: 'file_delete', taskId: id });
    expect(env.ctx.runs.activeCount()).toBe(0); // пока ждём, прогон не держит ресурсы

    await api('POST', `/api/approvals/${approval!.id}/approve`, h);
    await waitFor(async () => (await status(id)) === 'done');
    expect(await env.ctx.files.exists('old.log')).toBe(false);
    const steps = (await api('GET', `/api/tasks/${id}`, h)).body.steps as Json[];
    expect(steps.map((s) => s.type)).toContain('approval');
    expect((await api('GET', `/api/tasks/${id}`, h)).body.task.runCount).toBe(1); // продолжение, а не новый запуск
  });

  it('отказ в подтверждении: задача завершается без выполнения действия', async () => {
    env = await createTestEnv({
      script: (req, n) =>
        n === 1
          ? { toolCalls: [toolCall('file_delete', { path: 'x.txt' }, 'd')] }
          : {
              content: `Не удаляю: ${(req.messages.find((m) => m.role === 'tool') as { content: string }).content.slice(0, 20)}`,
            },
    });
    await env.ctx.files.write('x.txt', '1');
    const h = await login(env.app);
    const id = (await api('POST', '/api/tasks', h, { goal: 'Удали x.txt' })).body.item.id as string;
    await waitFor(async () => (await status(id)) === 'awaiting_approval');
    const [approval] = (await api('GET', '/api/approvals?status=pending', h)).body.items as Json[];
    await api('POST', `/api/approvals/${approval!.id}/reject`, h, {});
    await waitFor(async () => (await status(id)) === 'done');
    expect(await env.ctx.files.exists('x.txt')).toBe(true);
  });

  it('отмена задачи, ожидающей подтверждения, закрывает и само подтверждение', async () => {
    env = await createTestEnv({ script: () => ({ toolCalls: [toolCall('file_delete', { path: 'y.txt' }, 'd')] }) });
    await env.ctx.files.write('y.txt', '1');
    const h = await login(env.app);
    const id = (await api('POST', '/api/tasks', h, { goal: 'Удали y.txt' })).body.item.id as string;
    await waitFor(async () => (await status(id)) === 'awaiting_approval');
    expect((await api('POST', `/api/tasks/${id}/cancel`, h)).body.item.status).toBe('cancelled');
    expect((await api('GET', '/api/approvals?status=pending', h)).body.items).toHaveLength(0);
    expect(await env.ctx.files.exists('y.txt')).toBe(true);
    // отменённую задачу планировщик больше не трогает
    await env.ctx.scheduler.tick();
    expect(await status(id)).toBe('cancelled');
  });

  it('сбой моделей помечает задачу как невыполненную и уведомляет', async () => {
    env = await createTestEnv({ script: () => new Error('все лежат') });
    const h = await login(env.app);
    const id = (await api('POST', '/api/tasks', h, { goal: 'Что-нибудь сделай' })).body.item.id as string;
    await waitFor(async () => (await status(id)) === 'failed');
    const t = (await api('GET', `/api/tasks/${id}`, h)).body.task as Json;
    expect(t.lastError).toContain('Ни один провайдер');
    expect((await api('GET', '/api/notifications', h)).body.items[0]).toMatchObject({ kind: 'task_failed' });
  });

  it('бюджет задачи — жёсткий стоп именно для неё', async () => {
    env = await createTestEnv({
      script: () => ({ toolCalls: [toolCall('get_time', {})] }),
      config: { AGENT_MAX_STEPS: '30' },
    });
    const h = await login(env.app);
    const id = (await api('POST', '/api/tasks', h, { goal: 'Крути цикл', budget: { maxTokens: 1000 } })).body.item
      .id as string;
    await waitFor(async () => (await status(id)) === 'failed');
    expect(env.provider.calls.length).toBe(9); // 9 × 120 ≥ 1000 → стоп
    expect((await api('GET', `/api/tasks/${id}`, h)).body.task.lastError).toContain('Бюджет исчерпан');
  });

  it('после перезапуска незавершённая задача продолжается', async () => {
    env = await createTestEnv({ script: () => ({ content: 'доделал' }) });
    const h = await login(env.app);
    const row = (
      await env.ctx.db.query<{ id: string }>(
        `insert into tasks (goal, status, next_run_at) values ('Зависшая', 'in_progress', null) returning id`,
      )
    )[0]!;
    const id = row.id;
    expect(await env.ctx.tasks.recoverStuck()).toBe(1);
    await env.ctx.scheduler.tick();
    await waitFor(async () => (await status(id)) === 'done');
    expect((await api('GET', `/api/tasks/${id}`, h)).body.task.lastResult).toBe('доделал');
  });

  it('«Запустить сейчас», удаление, валидация', async () => {
    const now = new Date('2026-06-01T10:00:00Z');
    env = await createTestEnv({ clock: () => now, script: () => ({ content: 'ок' }) });
    const h = await login(env.app);
    const id = (
      await api('POST', '/api/tasks', h, {
        goal: 'Когда-нибудь',
        schedule: { type: 'daily', time: '23:00', timezone: 'UTC' },
      })
    ).body.item.id as string;
    expect(await status(id)).toBe('scheduled');
    await api('POST', `/api/tasks/${id}/run`, h);
    await waitFor(async () => (await env.ctx.tasks.get(id)).runCount === 1 && (await status(id)) === 'scheduled');
    expect((await env.ctx.tasks.get(id)).nextRunAt).toBe('2026-06-01T23:00:00.000Z');

    expect((await api('POST', '/api/tasks', h, { goal: 'x' })).status).toBe(400);
    expect(
      (await api('POST', '/api/tasks', h, { goal: 'нормальная цель', schedule: { type: 'interval', everyMinutes: 1 } }))
        .status,
    ).toBe(400);
    expect((await api('DELETE', `/api/tasks/${id}`, h)).status).toBe(200);
    expect((await api('GET', `/api/tasks/${id}`, h)).status).toBe(404);
  });

  it('агент из чата создаёт фоновую задачу через task_create (и откат её отменяет)', async () => {
    env = await createTestEnv({
      script: (req, n) => {
        const isTask = String(req.messages[0]!.content).includes('Режим фоновой задачи');
        if (isTask) return { content: 'сделано в фоне' };
        return n === 1
          ? {
              toolCalls: [
                toolCall('task_create', {
                  goal: 'Каждый день проверять новости',
                  schedule: { type: 'daily', time: '09:00' },
                }),
              ],
            }
          : { content: 'Создал задачу' };
      },
    });
    const h = await login(env.app);
    const { conversation } = (await api('POST', '/api/conversations', h, {})).body;
    await api('POST', `/api/conversations/${conversation.id}/messages`, h, { content: 'Проверяй новости каждое утро' });
    await env.ctx.runs.idle();
    const tasks = (await api('GET', '/api/tasks', h)).body.items as Json[];
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({ status: 'scheduled', schedule: { type: 'daily', time: '09:00' } });

    const entry = (await api('GET', '/api/actions?tool=task_create', h)).body.items[0];
    await api('POST', `/api/actions/${entry.id}/undo`, h);
    expect(await status(tasks[0]!.id)).toBe('cancelled');
  });
});

describe('утренняя сводка', () => {
  it('формируется раз в сутки после назначенного времени и приходит уведомлением', async () => {
    let now = new Date('2026-07-01T07:00:00Z');
    env = await createTestEnv({
      clock: () => now,
      script: (req) => {
        expect(String(req.messages[0]!.content)).toContain('Режим утренней сводки');
        expect(req.tools!.map((t) => t.name)).not.toContain('file_delete'); // у сводки только безопасные инструменты
        return { content: 'Доброе утро! Сегодня без срочных дел.' };
      },
    });
    const h = await login(env.app);
    await api('POST', '/api/tasks', h, {
      goal: 'Фоновая задача к сводке',
      schedule: { type: 'once', at: '2026-07-02T00:00:00Z' },
    });
    await api('POST', '/api/reminders', h, { text: 'Позвонить врачу', dueAt: '2026-07-01T10:00:00Z' });
    const set = await api('PUT', '/api/settings/morning', h, { enabled: true, time: '08:00', timezone: 'UTC' });
    expect(set.status).toBe(200);

    expect((await env.ctx.scheduler.tick()).morningStarted).toBe(false); // ещё рано

    now = new Date('2026-07-01T08:05:00Z');
    expect((await env.ctx.scheduler.tick()).morningStarted).toBe(true);
    await env.ctx.runs.idle();
    expect((await env.ctx.scheduler.tick()).morningStarted).toBe(false); // сегодня уже была

    const summaries = (await api('GET', '/api/conversations?kind=summary', h)).body.conversations as Json[];
    expect(summaries).toHaveLength(1);
    expect(summaries[0]!.title).toBe('Сводка 2026-07-01');
    const conv = (await api('GET', `/api/conversations/${summaries[0]!.id}`, h)).body;
    expect(conv.messages[0].content).toContain('Фоновая задача к сводке');
    expect(conv.messages[0].content).toContain('Позвонить врачу');
    expect(conv.messages.at(-1).content).toContain('Доброе утро');
    expect((await api('GET', '/api/notifications', h)).body.items[0]).toMatchObject({
      kind: 'morning',
      ref: { conversationId: summaries[0]!.id },
    });

    now = new Date('2026-07-02T08:01:00Z');
    expect((await env.ctx.scheduler.tick()).morningStarted).toBe(true); // новый день
    await env.ctx.runs.idle();
  });

  it('выключенная сводка не запускается; невалидные настройки отклоняются', async () => {
    env = await createTestEnv({ clock: () => new Date('2026-07-01T12:00:00Z') });
    const h = await login(env.app);
    expect((await env.ctx.scheduler.tick()).morningStarted).toBe(false);
    expect(
      (await api('PUT', '/api/settings/morning', h, { enabled: true, time: '25:99', timezone: 'UTC' })).status,
    ).toBe(400);
    expect(
      (await api('PUT', '/api/settings/morning', h, { enabled: true, time: '08:00', timezone: 'Mars/Base' })).status,
    ).toBe(400);
  });

  it('ручной запуск «Сформировать сейчас»', async () => {
    env = await createTestEnv({ script: () => ({ content: 'Сводка по запросу' }) });
    const h = await login(env.app);
    const { body } = await api('POST', '/api/morning/run', h);
    await env.ctx.runs.idle();
    const conv = (await api('GET', `/api/conversations/${body.conversationId}`, h)).body;
    expect(conv.messages.at(-1).content).toBe('Сводка по запросу');
  });
});
