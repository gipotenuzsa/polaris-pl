import { afterEach, describe, expect, it } from 'vitest';
import { createTestEnv, login, toolCall, type TestEnv } from './helpers.js';

let env: TestEnv;
afterEach(async () => env?.close());

async function chat(text: string, cfg: Parameters<typeof createTestEnv>[0]) {
  env = await createTestEnv(cfg);
  const h = await login(env.app);
  const { conversation } = (
    await env.app.inject({ method: 'POST', url: '/api/conversations', headers: h, payload: {} })
  ).json();
  await env.app.inject({
    method: 'POST',
    url: `/api/conversations/${conversation.id}/messages`,
    headers: h,
    payload: { content: text },
  });
  await env.ctx.runs.idle();
  return { h, conversationId: conversation.id as string };
}

const firstToolText = (req: { messages: { role: string; content?: string }[] }) =>
  req.messages.find((m) => m.role === 'tool')?.content ?? '';
const shortIdFrom = (req: Parameters<typeof firstToolText>[0]) => /id: ([0-9a-f]{8})/.exec(firstToolText(req))![1]!;

describe('заметки, напоминания, файлы и память через агента', () => {
  it('заметки: создать → найти → удалить только после подтверждения → откатить', async () => {
    const { h } = await chat('веди заметки', {
      script: (req, n) => {
        if (n === 1) return { toolCalls: [toolCall('note_create', { title: 'Покупки', body: 'молоко, хлеб' }, 'a')] };
        if (n === 2) return { toolCalls: [toolCall('note_list', { query: 'молоко' }, 'b')] };
        if (n === 3) return { toolCalls: [toolCall('note_delete', { id: shortIdFrom(req) }, 'c')] };
        return { content: 'готово' };
      },
    });
    expect(await env.ctx.db.query('select * from notes')).toHaveLength(1); // удаление ждёт подтверждения
    const [approval] = (await env.app.inject({ url: '/api/approvals?status=pending', headers: h })).json().items;
    expect(approval.action).toBe('note_delete');

    await env.app.inject({ method: 'POST', url: `/api/approvals/${approval.id}/approve`, headers: h });
    await env.ctx.runs.idle();
    expect(await env.ctx.db.query('select * from notes')).toHaveLength(0);

    const log = (await env.app.inject({ url: '/api/actions', headers: h })).json().items;
    expect(log.map((a: { tool: string }) => a.tool).reverse()).toEqual(['note_create', 'note_list', 'note_delete']);
    const del = log.find((a: { tool: string }) => a.tool === 'note_delete');
    await env.app.inject({ method: 'POST', url: `/api/actions/${del.id}/undo`, headers: h });
    expect(await env.ctx.db.query('select title, body from notes')).toEqual([
      { title: 'Покупки', body: 'молоко, хлеб' },
    ]);
  });

  it('напоминание срабатывает в назначенное время и создаёт уведомление', async () => {
    let now = new Date('2026-05-01T10:00:00Z');
    await chat('напомни через 5 минут позвонить', {
      clock: () => now,
      script: (_r, n) =>
        n === 1
          ? { toolCalls: [toolCall('reminder_create', { text: 'Позвонить маме', inMinutes: 5 })] }
          : { content: 'Напомню' },
    });
    const [rem] = await env.ctx.db.query<{ status: string; due_at: Date }>('select status, due_at from reminders');
    expect(rem).toMatchObject({ status: 'pending' });
    expect(new Date(rem!.due_at).toISOString()).toBe('2026-05-01T10:05:00.000Z');

    await env.ctx.scheduler.tick();
    expect(await env.ctx.notifications.list()).toHaveLength(0);

    now = new Date('2026-05-01T10:06:00Z');
    expect((await env.ctx.scheduler.tick()).remindersFired).toBe(1);
    const notes = await env.ctx.notifications.list();
    expect(notes[0]).toMatchObject({ kind: 'reminder', title: 'Напоминание', body: 'Позвонить маме', read: false });
    expect((await env.ctx.scheduler.tick()).remindersFired).toBe(0); // повторно не срабатывает
  });

  it('напоминание в прошлом отклоняется, время без пояса трактуется в поясе инстанса', async () => {
    const now = new Date('2026-05-01T10:00:00Z');
    await chat('напоминания', {
      clock: () => now,
      config: { INSTANCE_TIMEZONE: 'Asia/Almaty' }, // UTC+5
      script: (_r, n) => {
        if (n === 1)
          return { toolCalls: [toolCall('reminder_create', { text: 'старое', at: '2026-04-30T09:00' }, 'p')] };
        if (n === 2)
          return { toolCalls: [toolCall('reminder_create', { text: 'новое', at: '2026-05-02T09:00' }, 'q')] };
        return { content: 'ок' };
      },
    });
    const rows = await env.ctx.db.query<{ due_at: Date }>('select due_at from reminders');
    expect(rows).toHaveLength(1);
    expect(new Date(rows[0]!.due_at).toISOString()).toBe('2026-05-02T04:00:00.000Z'); // 09:00 по Алматы
    const log = await env.ctx.actions.list();
    expect(log.find((a) => a.summary.includes('уже прошло'))).toMatchObject({ status: 'error' });
  });

  it('файлы: служебные каталоги недоступны, выход за корень невозможен', async () => {
    const { h, conversationId } = await chat('файлы', {
      script: (_r, n) => {
        if (n === 1) {
          return {
            toolCalls: [
              toolCall('file_write', { path: 'ok/a.txt', content: 'привет' }, '1'),
              toolCall('file_read', { path: '_trash/x/y.txt' }, '2'),
              toolCall('file_write', { path: '../evil.txt', content: 'x' }, '3'),
            ],
          };
        }
        if (n === 2)
          return { toolCalls: [toolCall('file_list', {}, '4'), toolCall('file_read', { path: 'ok/a.txt' }, '5')] };
        return { content: 'ок' };
      },
    });
    const conv = (await env.app.inject({ url: `/api/conversations/${conversationId}`, headers: h })).json();
    const tools = conv.messages.filter((m: { role: string }) => m.role === 'tool');
    expect(tools.map((t: { status: string }) => t.status)).toEqual(['ok', 'error', 'error', 'ok', 'ok']);
    expect(tools[1].content).toContain('служебный');
    expect(tools[2].content).toMatch(/Недопустимый путь/);
    expect(tools[4].content).toBe('привет');
    expect(await env.ctx.files.exists('ok/a.txt')).toBe(true);
  });

  it('память: изменение по короткому id, удаление — с подтверждением (отказ сохраняет запись)', async () => {
    const { h } = await chat('память', {
      script: (req, n) => {
        if (n === 1)
          return { toolCalls: [toolCall('memory_save', { kind: 'fact', content: 'Работает в банке' }, 'a')] };
        if (n === 2)
          return {
            toolCalls: [toolCall('memory_update', { id: shortIdFrom(req), content: 'Работает в студии' }, 'b')],
          };
        if (n === 3) return { toolCalls: [toolCall('memory_delete', { id: shortIdFrom(req) }, 'c')] };
        return { content: 'ок' };
      },
    });
    expect((await env.ctx.memory.list())[0]!.content).toBe('Работает в студии');
    const [approval] = (await env.app.inject({ url: '/api/approvals?status=pending', headers: h })).json().items;
    expect(approval.action).toBe('memory_delete');
    await env.app.inject({ method: 'POST', url: `/api/approvals/${approval.id}/reject`, headers: h, payload: {} });
    await env.ctx.runs.idle();
    expect(await env.ctx.memory.list()).toHaveLength(1);
  });

  it('откат сохранения в память и обновления заметки', async () => {
    const { h } = await chat('правки', {
      script: (req, n) => {
        if (n === 1)
          return {
            toolCalls: [
              toolCall('note_create', { title: 'Идея', body: 'v1' }, 'a'),
              toolCall('memory_save', { kind: 'preference', content: 'Любит чай' }, 'b'),
            ],
          };
        if (n === 2)
          return {
            toolCalls: [
              toolCall('note_update', { id: /id: ([0-9a-f]{8})/.exec(firstToolText(req))![1]!, body: 'v2' }, 'c'),
            ],
          };
        return { content: 'ок' };
      },
    });
    const log = (await env.app.inject({ url: '/api/actions', headers: h })).json().items as {
      id: string;
      tool: string;
      undoable: boolean;
    }[];
    expect(
      log
        .filter((a) => a.undoable)
        .map((a) => a.tool)
        .sort(),
    ).toEqual(['memory_save', 'note_create', 'note_update']);
    const undo = (tool: string) =>
      env.app.inject({ method: 'POST', url: `/api/actions/${log.find((a) => a.tool === tool)!.id}/undo`, headers: h });

    await undo('note_update');
    expect((await env.ctx.db.query<{ body: string }>('select body from notes'))[0]!.body).toBe('v1');
    await undo('memory_save');
    expect(await env.ctx.memory.list()).toHaveLength(0);
    await undo('note_create');
    expect(await env.ctx.db.query('select * from notes')).toHaveLength(0);
  });
});
