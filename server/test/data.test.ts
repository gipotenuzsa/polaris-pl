import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTestEnv, login, waitFor, type TestEnv } from './helpers.js';

let env: TestEnv;
afterEach(async () => {
  vi.restoreAllMocks();
  await env?.close();
});
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6l1kAAAAASUVORK5CYII=';
const count = async (table: string) =>
  (await env.ctx.db.query<{ n: number }>(`select count(*)::int as n from ${table}`))[0]!.n;
const clear = (path: string, headers: Record<string, string>, payload: Record<string, unknown> = { confirm: true }) =>
  env.app.inject({ method: 'POST', url: `/api/data/${path}`, headers, payload });

async function photo(conversationId?: string) {
  const attachment = await env.ctx.conversations.createAttachment({ name: 'photo.png', mime: 'image/png', data: PNG });
  if (conversationId)
    await env.ctx.conversations.addUserMessage(conversationId, 'Секрет на фотографии', [attachment.id]);
  return attachment;
}

describe('управление чатами и данными', () => {
  it('очистка требует сессию и явное подтверждение, обычный GET ничего не удаляет', async () => {
    env = await createTestEnv();
    const chat = await env.ctx.conversations.create('Сохранить');
    const headers = await login(env.app);
    for (const path of ['clear-chats', 'clear-all']) {
      expect((await clear(path, {})).statusCode).toBe(401);
      expect((await clear(path, headers, {})).statusCode).toBe(400);
      expect((await clear(path, headers, { confirm: false })).statusCode).toBe(400);
      expect((await env.app.inject({ url: `/api/data/${path}`, headers })).statusCode).not.toBe(200);
    }
    expect(await env.ctx.conversations.get(chat.id)).toMatchObject({ title: 'Сохранить' });
  });

  it('удаление отдельного чата очищает фото и связанные данные, сохраняя остальные разговоры', async () => {
    env = await createTestEnv();
    const headers = await login(env.app);
    const main = await env.ctx.conversations.main();
    const keep = await env.ctx.conversations.create('Другой чат');
    const attachment = await photo(main.id);
    const [approval] = await env.ctx.db.query<{ id: string }>(
      "insert into approvals (action, summary, conversation_id) values ('file_delete', 'Секретное действие', $1) returning id",
      [main.id],
    );
    await env.ctx.db.query(
      "insert into actions_log (tool, status, conversation_id, approval_id) values ('file_read', 'ok', $1, $2)",
      [main.id, approval!.id],
    );
    await env.ctx.db.query("insert into usage_log (provider, conversation_id) values ('test', $1)", [main.id]);
    await env.ctx.notifications.create({
      kind: 'approval',
      title: 'Секретное действие',
      ref: { approvalId: approval!.id },
    });
    await env.ctx.notifications.create({
      kind: 'info',
      title: 'Секретный результат',
      ref: { conversationId: main.id },
    });
    await env.ctx.notifications.create({ kind: 'info', title: 'Оставить', ref: { conversationId: keep.id } });
    const response = await env.app.inject({ method: 'DELETE', url: `/api/conversations/${main.id}`, headers });
    expect(response.statusCode).toBe(200);
    expect((await env.app.inject({ url: `/api/conversations/${main.id}`, headers })).statusCode).toBe(404);
    expect((await env.app.inject({ url: `/api/attachments/${attachment.id}`, headers })).statusCode).toBe(404);
    expect(await count('approvals')).toBe(0);
    expect(await count('actions_log')).toBe(0);
    expect(await count('usage_log')).toBe(0);
    expect((await env.ctx.notifications.list()).map((n) => n.title)).toEqual(['Оставить']);
    expect(await env.ctx.conversations.list()).toMatchObject([{ id: keep.id }]);
  });

  it('удаление всех чатов включает прежний общий разговор и сводки, сохраняя память и историю задач', async () => {
    env = await createTestEnv();
    const headers = await login(env.app);
    await photo((await env.ctx.conversations.main()).id);
    await photo((await env.ctx.conversations.create('Отдельный чат')).id);
    await photo((await env.ctx.conversations.create('Сводка', 'summary')).id);
    await photo(); // unfinished upload
    const taskChat = await env.ctx.conversations.create('История задачи', 'task');
    const retainedPhoto = await photo(taskChat.id);
    await env.ctx.memory.create({ kind: 'fact', content: 'Сохранить память', source: 'user' });
    await env.ctx.notes.create('Заметка', 'Сохранить текст');
    await env.ctx.settings.set('agent', { instructions: 'Сохранить настройки' });
    await env.ctx.files.write('document.txt', 'Сохранить файл');
    expect((await clear('clear-chats', headers)).statusCode).toBe(200);
    expect(await env.ctx.conversations.list()).toEqual([]);
    expect(await env.ctx.conversations.list('summary')).toEqual([]);
    expect(await count('conversations')).toBe(1);
    expect(await count('attachments')).toBe(1);
    expect(await env.ctx.conversations.getAttachment(retainedPhoto.id)).toBeDefined();
    expect(await count('memory')).toBe(1);
    expect(await count('notes')).toBe(1);
    expect((await env.ctx.settings.getAgent()).instructions).toBe('Сохранить настройки');
    expect((await env.ctx.files.read('document.txt'))?.toString()).toBe('Сохранить файл');
    expect((await clear('clear-chats', headers)).statusCode).toBe(200);
  });

  it('полный сброс удаляет все личные данные, вложенные файлы, корзину, ключи и сессии', async () => {
    env = await createTestEnv();
    const headers = await login(env.app);
    await photo((await env.ctx.conversations.main()).id);
    await env.ctx.memory.create({ kind: 'fact', content: 'Секретный факт', source: 'user' });
    await env.ctx.notes.create('Секрет', 'Личная заметка');
    await env.ctx.reminders.create('Секретное напоминание', new Date(Date.now() + 3_600_000));
    await env.ctx.db.query("insert into tasks (goal) values ('Секретная задача')");
    await env.ctx.db.query("insert into provider_credentials (provider, encrypted_token) values ('chatgpt', 'secret')");
    await env.ctx.db.query(
      "insert into oauth_flows (state, provider, code_verifier) values ('secret', 'chatgpt', 'verifier')",
    );
    await env.ctx.db.query(
      "insert into push_subscriptions (endpoint, p256dh, auth) values ('https://push.example/sub', 'key', 'auth')",
    );
    await env.ctx.settings.set('agent', { instructions: 'Секретные инструкции' });
    const oldKey = await env.ctx.push.publicKey();
    const files = ['visible.txt', 'nested/deeper/secret.txt', '_trash/old.txt', '_versions/old.txt'];
    for (const path of files) await env.ctx.files.write(path, 'secret');
    expect((await clear('clear-all', headers)).statusCode).toBe(200);
    for (const table of [
      'conversations',
      'messages',
      'attachments',
      'memory',
      'notes',
      'tasks',
      'task_steps',
      'reminders',
      'notifications',
      'actions_log',
      'approvals',
      'usage_log',
      'settings',
      'sessions',
      'provider_credentials',
      'oauth_flows',
      'push_subscriptions',
    ]) {
      expect(await count(table), table).toBe(0);
    }
    for (const path of files) expect(await env.ctx.files.read(path), path).toBeNull();
    expect((await env.app.inject({ url: '/api/conversations', headers })).statusCode).toBe(401);
    const freshSession = await login(env.app);
    expect(
      (await env.app.inject({ method: 'POST', url: '/api/conversations', headers: freshSession, payload: {} }))
        .statusCode,
    ).toBe(200);
    expect(await env.ctx.push.publicKey()).not.toBe(oldKey);
  });

  it('не удаляет данные во время активного ответа; после завершения удаление доступно', async () => {
    env = await createTestEnv();
    const headers = await login(env.app);
    const chat = await env.ctx.conversations.create('Активный чат');
    let release!: () => void;
    const run = env.ctx.runs.start(
      chat.id,
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    try {
      expect((await clear('clear-chats', headers)).statusCode).toBe(409);
      expect((await clear('clear-all', headers)).statusCode).toBe(409);
      expect(
        (await env.app.inject({ method: 'DELETE', url: `/api/conversations/${chat.id}`, headers })).statusCode,
      ).toBe(409);
      expect(await count('conversations')).toBe(1);
    } finally {
      release();
      await run;
      await env.ctx.runs.idle();
    }
    expect((await clear('clear-chats', headers)).statusCode).toBe(200);
  });

  it('блокирует новые записи и планировщик до завершения очистки', async () => {
    env = await createTestEnv();
    const headers = await login(env.app);
    let release!: () => void;
    let started = false;
    vi.spyOn(env.ctx.files, 'list').mockImplementationOnce(async () => {
      started = true;
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return [];
    });
    const pending = clear('clear-all', headers).then((result) => result);
    await waitFor(async () => started);
    try {
      expect(
        (
          await env.app.inject({
            method: 'POST',
            url: '/api/memory',
            headers,
            payload: { kind: 'fact', content: 'Новая запись' },
          })
        ).statusCode,
      ).toBe(409);
      expect((await env.app.inject({ url: '/api/main', headers })).statusCode).toBe(409);
      expect((await clear('clear-chats', headers)).statusCode).toBe(409);
      expect(await env.ctx.scheduler.tick()).toMatchObject({ skipped: true });
    } finally {
      release();
    }
    expect((await pending).statusCode).toBe(200);
    expect(await count('memory')).toBe(0);
    expect(await count('conversations')).toBe(0);
  });

  it('при сбое хранилища сохраняет базу и позволяет повторить очистку', async () => {
    env = await createTestEnv();
    const headers = await login(env.app);
    await env.ctx.conversations.create('Сохранить до успешного удаления');
    await env.ctx.files.write('secret.txt', 'secret');
    vi.spyOn(env.ctx.files, 'remove').mockRejectedValueOnce(new Error('Storage unavailable'));
    expect((await clear('clear-all', headers)).statusCode).toBe(500);
    expect(await count('conversations')).toBe(1);
    expect(await count('sessions')).toBe(1);
    expect((await clear('clear-all', headers)).statusCode).toBe(200);
    expect(await env.ctx.files.read('secret.txt')).toBeNull();
  });

  it('не отправляет сообщение с пропавшей или повторяющейся фотографией', async () => {
    env = await createTestEnv();
    const headers = await login(env.app);
    const chat = await env.ctx.conversations.create();
    const attachment = await photo();
    for (const attachmentIds of [[randomUUID()], [attachment.id, attachment.id]]) {
      const response = await env.app.inject({
        method: 'POST',
        url: `/api/conversations/${chat.id}/messages`,
        headers,
        payload: { content: 'Фото обязательно', attachmentIds },
      });
      expect(response.statusCode).toBe(409);
      expect(await count('messages')).toBe(0);
    }
    expect(await count('attachments')).toBe(1);
  });
});
