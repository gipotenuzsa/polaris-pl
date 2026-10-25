import { createECDH, randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import webpush from 'web-push';
import type { PushSender, SendOptions } from '../src/services/push.js';
import { createTestEnv, login, toolCall, waitFor, type TestEnv } from './helpers.js';

let env: TestEnv;
afterEach(async () => {
  await env?.close();
  env = undefined as unknown as TestEnv;
});

interface Sent {
  endpoint: string;
  payload: { title: string; body: string; url: string; tag?: string };
  options: SendOptions;
}

function recorder(fail?: (endpoint: string) => number | undefined) {
  const sent: Sent[] = [];
  const sender: PushSender = async (sub, payload, options) => {
    const status = fail?.(sub.endpoint);
    if (status) throw Object.assign(new Error(`push service ${status}`), { statusCode: status });
    sent.push({ endpoint: sub.endpoint, payload: JSON.parse(payload), options });
    return { statusCode: 201 };
  };
  return { sent, sender };
}

const sub = (n = 1) => ({
  endpoint: `https://push.example.test/send/device-${n}`,
  keys: { p256dh: 'BPubKeyPubKeyPubKeyPubKey' + n, auth: 'authsecret' + n },
});

describe('Web Push', () => {
  it('ключи VAPID создаются один раз, стабильны, закрытый ключ в БД зашифрован', async () => {
    env = await createTestEnv();
    const h = await login(env.app);
    const a = (await env.app.inject({ url: '/api/push/status', headers: h })).json();
    expect(a.publicKey).toMatch(/^[A-Za-z0-9_-]{80,}$/);
    expect(a.subscriptions).toBe(0);
    const b = (await env.app.inject({ url: '/api/push/status', headers: h })).json();
    expect(b.publicKey).toBe(a.publicKey);

    const row = (
      await env.ctx.db.query<{ value: { publicKey: string; privateKeyEnc: string } }>(
        `select value from settings where key = 'webpush'`,
      )
    )[0]!;
    expect(row.value.publicKey).toBe(a.publicKey);
    expect(row.value.privateKeyEnc.split('.')).toHaveLength(3); // iv.tag.ciphertext
    expect(JSON.stringify(row.value)).not.toMatch(/"privateKey"/);
  });

  it('API закрыт без входа; подписка проверяется и идемпотентна', async () => {
    env = await createTestEnv();
    expect((await env.app.inject({ url: '/api/push/status' })).statusCode).toBe(401);
    const h = await login(env.app);
    const post = (payload: unknown) =>
      env.app.inject({ method: 'POST', url: '/api/push/subscribe', headers: h, payload: payload as object });

    expect((await post({ endpoint: 'http://push.example.test/x', keys: sub().keys })).statusCode).toBe(400); // не https
    expect((await post({ endpoint: 'https://localhost/x', keys: sub().keys })).statusCode).toBe(400);
    expect((await post({ endpoint: 'https://127.0.0.1/x', keys: sub().keys })).statusCode).toBe(400);
    expect((await post({ endpoint: 'https://10.0.0.5/x', keys: sub().keys })).statusCode).toBe(400);
    expect((await post({ endpoint: 'https://push.example.test/x' })).statusCode).toBe(400);

    expect((await post(sub(1))).json().subscriptions).toBe(1);
    expect((await post(sub(1))).json().subscriptions).toBe(1); // тот же endpoint — не дублируется
    expect((await post(sub(2))).json().subscriptions).toBe(2);
    const un = await env.app.inject({
      method: 'POST',
      url: '/api/push/unsubscribe',
      headers: h,
      payload: { endpoint: sub(1).endpoint },
    });
    expect(un.json().subscriptions).toBe(1);
  });

  it('тест-уведомление уходит на все устройства; без подписок — понятная ошибка', async () => {
    const { sent, sender } = recorder();
    env = await createTestEnv({ pushSender: sender });
    const h = await login(env.app);
    const none = await env.app.inject({ method: 'POST', url: '/api/push/test', headers: h });
    expect(none.statusCode).toBe(409);
    expect(none.json().error).toBe('no_subscriptions');

    await env.ctx.push.subscribe(sub(1));
    await env.ctx.push.subscribe(sub(2));
    const res = await env.app.inject({ method: 'POST', url: '/api/push/test', headers: h });
    expect(res.json()).toEqual({ sent: 2, removed: 0, failed: 0 });
    expect(sent.map((s) => s.endpoint).sort()).toEqual([sub(1).endpoint, sub(2).endpoint]);
    expect(sent[0]!.payload).toMatchObject({ title: 'Polaris', url: '/inbox', tag: 'push-test' });
    // подпись VAPID: открытый ключ совпадает с тем, что получает клиент, закрытый расшифрован
    const status = (await env.app.inject({ url: '/api/push/status', headers: h })).json();
    expect(sent[0]!.options.vapidDetails.publicKey).toBe(status.publicKey);
    expect(sent[0]!.options.vapidDetails.privateKey).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    expect(sent[0]!.options.vapidDetails.subject).toMatch(/^(mailto:|https:)/);
  });

  it('каждое уведомление из приложения дублируется пушем со ссылкой на нужный экран', async () => {
    const { sent, sender } = recorder();
    env = await createTestEnv({ pushSender: sender });
    await env.ctx.push.subscribe(sub());
    const n = env.ctx.notifications;
    await n.create({
      kind: 'approval',
      title: 'Нужно подтверждение',
      body: 'Удалить файл a.txt',
      ref: { approvalId: 'x' },
    });
    await n.create({
      kind: 'task_done',
      title: 'Готово: отчёт',
      body: 'Итог',
      ref: { taskId: 't1', conversationId: 'c1' },
    });
    await n.create({ kind: 'reminder', title: 'Напоминание', body: 'Позвонить маме' });
    await waitFor(async () => sent.length === 3);

    const byTitle = Object.fromEntries(sent.map((s) => [s.payload.title, s]));
    expect(byTitle['Нужно подтверждение']!.payload.url).toBe('/approvals');
    expect(byTitle['Нужно подтверждение']!.options.urgency).toBe('high');
    expect(byTitle['Готово: отчёт']!.payload.url).toBe('/chat/c1');
    expect(byTitle['Готово: отчёт']!.options.urgency).toBe('normal');
    expect(byTitle['Напоминание']!.payload).toMatchObject({ url: '/inbox', body: 'Позвонить маме' });
  });

  it('длинный текст усекается, чтобы уместиться в пуш', async () => {
    const { sent, sender } = recorder();
    env = await createTestEnv({ pushSender: sender });
    await env.ctx.push.subscribe(sub());
    await env.ctx.push.send({ title: 'T'.repeat(300), body: 'я'.repeat(3000), url: '/inbox' });
    expect(sent[0]!.payload.title.length).toBeLessThanOrEqual(80);
    expect(sent[0]!.payload.body.length).toBeLessThanOrEqual(200);
  });

  it('отозванные подписки (404/410) удаляются, временные сбои — нет', async () => {
    const { sent, sender } = recorder((ep) => (ep.endsWith('gone') ? 410 : ep.endsWith('flaky') ? 503 : undefined));
    env = await createTestEnv({ pushSender: sender });
    await env.ctx.push.subscribe({ ...sub(1), endpoint: 'https://push.example.test/send/gone' });
    await env.ctx.push.subscribe({ ...sub(2), endpoint: 'https://push.example.test/send/flaky' });
    await env.ctx.push.subscribe(sub(3));

    const res = await env.ctx.push.send({ title: 'x', body: 'y', url: '/' });
    expect(res).toEqual({ sent: 1, removed: 1, failed: 1 });
    expect(sent).toHaveLength(1);
    expect(await env.ctx.push.count()).toBe(2); // «gone» удалена, «flaky» осталась
  });

  it('ответ в чате приходит пушем, только если пользователь не смотрит на экран', async () => {
    let now = new Date('2026-09-01T10:00:00Z');
    const { sent, sender } = recorder();
    env = await createTestEnv({
      pushSender: sender,
      clock: () => now,
      script: (_r, n) => ({ content: `Ответ номер ${n}` }),
    });
    await env.ctx.push.subscribe(sub());
    const h = await login(env.app);
    const { conversation } = (
      await env.app.inject({ method: 'POST', url: '/api/conversations', headers: h, payload: {} })
    ).json();
    const say = async (text: string) => {
      await env.app.inject({
        method: 'POST',
        url: `/api/conversations/${conversation.id}/messages`,
        headers: h,
        payload: { content: text },
      });
      await env.ctx.runs.idle();
      await new Promise((r) => setTimeout(r, 30)); // отправка пуша идёт в фоне
    };

    await say('привет'); // пользователь только что писал — смотрит на экран
    expect(sent).toHaveLength(0);

    now = new Date(now.getTime() + 60_000); // прошла минута, экран закрыт
    await env.ctx.runs.startChat(conversation.id); // продолжение работы агента без участия клиента
    await env.ctx.runs.idle();
    await waitFor(async () => sent.length === 1);
    expect(sent[0]!.payload).toMatchObject({
      title: 'Polaris',
      url: `/chat/${conversation.id}`,
      tag: `chat-${conversation.id}`,
    });
    expect(sent[0]!.payload.body).toContain('Ответ номер');
  });

  it('запрос подтверждения из чата приходит пушем с переходом на «Подтверждения»', async () => {
    const { sent, sender } = recorder();
    env = await createTestEnv({
      pushSender: sender,
      script: () => ({ toolCalls: [toolCall('file_delete', { path: 'a.txt' })] }),
    });
    await env.ctx.files.write('a.txt', '1');
    await env.ctx.push.subscribe(sub());
    const h = await login(env.app);
    const { conversation } = (
      await env.app.inject({ method: 'POST', url: '/api/conversations', headers: h, payload: {} })
    ).json();
    await env.app.inject({
      method: 'POST',
      url: `/api/conversations/${conversation.id}/messages`,
      headers: h,
      payload: { content: 'удали a.txt' },
    });
    await env.ctx.runs.idle();
    await waitFor(async () => sent.length >= 1);
    expect(sent[0]!.payload).toMatchObject({ title: 'Нужно подтверждение', url: '/approvals' });
    expect(sent[0]!.options.urgency).toBe('high');
  });

  it('настоящая библиотека web-push принимает наши ключи и строит зашифрованный запрос', async () => {
    env = await createTestEnv();
    const ecdh = createECDH('prime256v1');
    ecdh.generateKeys();
    const real = {
      endpoint: 'https://web.push.apple.com/QGdummy-token',
      keys: { p256dh: ecdh.getPublicKey().toString('base64url'), auth: randomBytes(16).toString('base64url') },
    };
    const publicKey = await env.ctx.push.publicKey();
    const row = (
      await env.ctx.db.query<{ value: { privateKeyEnc: string } }>(`select value from settings where key = 'webpush'`)
    )[0]!;
    const { decryptSecret } = await import('../src/crypto/secrets.js');
    const privateKey = decryptSecret(row.value.privateKeyEnc, env.ctx.config.encryptionKey);

    const details = webpush.generateRequestDetails(real, JSON.stringify({ title: 'Привет', body: 'Мир', url: '/' }), {
      vapidDetails: { subject: 'mailto:polaris@example.com', publicKey, privateKey },
      TTL: 3600,
      urgency: 'high',
    });
    expect(details.endpoint).toBe(real.endpoint);
    expect(String(details.headers.Authorization)).toMatch(/^vapid t=.+, k=.+$/);
    expect(details.headers['Content-Encoding']).toBe('aes128gcm');
    expect(details.headers.Urgency).toBe('high');
    expect(Buffer.isBuffer(details.body)).toBe(true);
  });
});
