import { afterEach, describe, expect, it } from 'vitest';
import { createTestEnv, login, TEST_PASSWORD, toolCall, type TestEnv } from './helpers.js';

let env: TestEnv;
afterEach(async () => env?.close());

describe('аутентификация и безопасность HTTP', () => {
  it('/health открыт и не раскрывает состояние', async () => {
    env = await createTestEnv();
    const res = await env.app.inject({ url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });

  it('API закрыт без сессии, вход по паролю открывает', async () => {
    env = await createTestEnv();
    expect((await env.app.inject({ url: '/api/conversations' })).statusCode).toBe(401);
    expect((await env.app.inject({ url: '/api/status' })).statusCode).toBe(401);

    const bad = await env.app.inject({ method: 'POST', url: '/api/auth/login', payload: { password: 'неверный' } });
    expect(bad.statusCode).toBe(401);

    const ok = await env.app.inject({ method: 'POST', url: '/api/auth/login', payload: { password: TEST_PASSWORD } });
    expect(ok.statusCode).toBe(200);
    const cookie = ok.cookies.find((c) => c.name === 'polaris_session')!;
    expect(cookie.httpOnly).toBe(true);
    expect(cookie.sameSite).toBe('Strict');

    const withCookie = await env.app.inject({ url: '/api/conversations', cookies: { polaris_session: cookie.value } });
    expect(withCookie.statusCode).toBe(200);
    const session = await env.app.inject({ url: '/api/auth/session', cookies: { polaris_session: cookie.value } });
    expect(session.json()).toMatchObject({ authenticated: true });
  });

  it('в БД хранится только хэш токена сессии', async () => {
    env = await createTestEnv();
    const ok = await env.app.inject({ method: 'POST', url: '/api/auth/login', payload: { password: TEST_PASSWORD } });
    const { token } = ok.json() as { token: string };
    const rows = await env.ctx.db.query<{ token_hash: string }>('select token_hash from sessions');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.token_hash).not.toContain(token);
  });

  it('cookie-запросы с чужого Origin отклоняются (CSRF), Bearer — нет', async () => {
    env = await createTestEnv();
    const ok = await env.app.inject({ method: 'POST', url: '/api/auth/login', payload: { password: TEST_PASSWORD } });
    const cookie = ok.cookies[0]!.value;
    const evil = await env.app.inject({
      method: 'POST',
      url: '/api/conversations',
      payload: {},
      cookies: { polaris_session: cookie },
      headers: { origin: 'https://evil.example' },
    });
    expect(evil.statusCode).toBe(403);
    const same = await env.app.inject({
      method: 'POST',
      url: '/api/conversations',
      payload: {},
      cookies: { polaris_session: cookie },
      headers: { origin: 'http://localhost:80', host: 'localhost:80' },
    });
    expect(same.statusCode).toBe(200);
  });

  it('выход инвалидирует сессию', async () => {
    env = await createTestEnv();
    const h = await login(env.app);
    expect((await env.app.inject({ url: '/api/conversations', headers: h })).statusCode).toBe(200);
    await env.app.inject({ method: 'POST', url: '/api/auth/logout', headers: h });
    expect((await env.app.inject({ url: '/api/conversations', headers: h })).statusCode).toBe(401);
  });

  it('перебор пароля ограничивается', async () => {
    env = await createTestEnv();
    const codes: number[] = [];
    for (let i = 0; i < 10; i++) {
      const r = await env.app.inject({ method: 'POST', url: '/api/auth/login', payload: { password: 'x' + i } });
      codes.push(r.statusCode);
    }
    expect(codes).toContain(429);
  }, 60_000);

  it('без настроенного пароля вход невозможен', async () => {
    env = await createTestEnv({ config: { POLARIS_PASSWORD_HASH: '' } });
    const r = await env.app.inject({ method: 'POST', url: '/api/auth/login', payload: { password: 'anything' } });
    expect(r.statusCode).toBe(503);
  });

  it('/internal/tick требует секрет', async () => {
    env = await createTestEnv();
    expect((await env.app.inject({ method: 'POST', url: '/internal/tick' })).statusCode).toBe(401);
    expect(
      (await env.app.inject({ method: 'POST', url: '/internal/tick', headers: { 'x-cron-secret': 'wrong' } }))
        .statusCode,
    ).toBe(401);
    const ok = await env.app.inject({
      method: 'POST',
      url: '/internal/tick',
      headers: { 'x-cron-secret': 'cron-secret-for-tests' },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ tasksStarted: 0 });
  });

  it('неизвестные пути и ошибки валидации отдают JSON без деталей реализации', async () => {
    env = await createTestEnv();
    const h = await login(env.app);
    const nf = await env.app.inject({ url: '/api/nope', headers: h });
    expect(nf.statusCode).toBe(404);
    const bad = await env.app.inject({
      method: 'POST',
      url: '/api/memory',
      headers: h,
      payload: { kind: 'wrong', content: 'x' },
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().message).toContain('kind');
    const badId = await env.app.inject({ url: '/api/tasks/not-a-uuid', headers: h });
    expect(badId.statusCode).toBe(400);
  });
});

describe('чат', () => {
  it('отправка сообщения запускает агента, история сохраняется, usage считается', async () => {
    env = await createTestEnv({ script: () => ({ content: 'Привет! Чем помочь?' }) });
    const h = await login(env.app);
    const { conversation } = (
      await env.app.inject({ method: 'POST', url: '/api/conversations', headers: h, payload: {} })
    ).json();

    const post = await env.app.inject({
      method: 'POST',
      url: `/api/conversations/${conversation.id}/messages`,
      headers: h,
      payload: { content: 'Здравствуй, Polaris' },
    });
    expect(post.statusCode).toBe(202);
    await env.ctx.runs.idle();

    const got = (await env.app.inject({ url: `/api/conversations/${conversation.id}`, headers: h })).json();
    expect(got.running).toBe(false);
    expect(got.conversation.title).toBe('Здравствуй, Polaris');
    expect(got.messages.map((m: { role: string }) => m.role)).toEqual(['user', 'assistant']);
    expect(got.messages[1]).toMatchObject({ content: 'Привет! Чем помочь?', provider: 'openrouter' });

    // инкрементальная загрузка
    const after = (
      await env.app.inject({ url: `/api/conversations/${conversation.id}?after=${got.messages[0].seq}`, headers: h })
    ).json();
    expect(after.messages).toHaveLength(1);

    const budget = (await env.app.inject({ url: '/api/budget', headers: h })).json();
    expect(budget.daily.tokens).toBe(120);

    // модель получила системный промпт, историю и список инструментов
    const req = env.provider.calls[0]!;
    expect(req.messages[0]!.role).toBe('system');
    expect(req.messages.at(-1)).toEqual({ role: 'user', content: 'Здравствуй, Polaris' });
    expect(req.tools!.map((t) => t.name)).toEqual(
      expect.arrayContaining(['memory_save', 'note_create', 'file_write', 'task_create', 'read_url']),
    );
    expect(req.tools!.map((t) => t.name)).not.toContain('web_search'); // нет BRAVE_API_KEY
    expect(req.tools!.map((t) => t.name)).not.toContain('browser_read'); // браузер выключен
  });

  it('контекст: второй вопрос видит предыдущий диалог', async () => {
    env = await createTestEnv({ script: (_r, n) => ({ content: `ответ ${n}` }) });
    const h = await login(env.app);
    const { conversation } = (
      await env.app.inject({ method: 'POST', url: '/api/conversations', headers: h, payload: {} })
    ).json();
    for (const text of ['первый', 'второй']) {
      await env.app.inject({
        method: 'POST',
        url: `/api/conversations/${conversation.id}/messages`,
        headers: h,
        payload: { content: text },
      });
      await env.ctx.runs.idle();
    }
    const roles = env.provider.calls[1]!.messages.map((m) => m.role);
    expect(roles).toEqual(['system', 'user', 'assistant', 'user']);
  });

  it('сбой всех провайдеров виден пользователю, а не молча теряется', async () => {
    env = await createTestEnv({ script: () => new Error('нет сети') });
    const h = await login(env.app);
    const { conversation } = (
      await env.app.inject({ method: 'POST', url: '/api/conversations', headers: h, payload: {} })
    ).json();
    await env.app.inject({
      method: 'POST',
      url: `/api/conversations/${conversation.id}/messages`,
      headers: h,
      payload: { content: 'привет' },
    });
    await env.ctx.runs.idle();
    const got = (await env.app.inject({ url: `/api/conversations/${conversation.id}`, headers: h })).json();
    expect(got.messages.at(-1)).toMatchObject({
      role: 'assistant',
      status: 'error',
      content: expect.stringContaining('Не удалось получить ответ модели'),
    });
  });

  it('удаление чата и переименование', async () => {
    env = await createTestEnv();
    const h = await login(env.app);
    const { conversation } = (
      await env.app.inject({ method: 'POST', url: '/api/conversations', headers: h, payload: { title: 'Старое' } })
    ).json();
    await env.app.inject({
      method: 'PATCH',
      url: `/api/conversations/${conversation.id}`,
      headers: h,
      payload: { title: 'Новое' },
    });
    expect((await env.app.inject({ url: '/api/conversations', headers: h })).json().conversations[0].title).toBe(
      'Новое',
    );
    await env.app.inject({ method: 'DELETE', url: `/api/conversations/${conversation.id}`, headers: h });
    expect((await env.app.inject({ url: `/api/conversations/${conversation.id}`, headers: h })).statusCode).toBe(404);
  });
});

describe('память', () => {
  it('агент сохраняет факт, пользователь видит, правит и удаляет', async () => {
    env = await createTestEnv({
      script: (_r, n) =>
        n === 1
          ? {
              content: '',
              toolCalls: [toolCall('memory_save', { kind: 'preference', content: 'Любит краткие ответы' })],
            }
          : { content: 'Запомнил!' },
    });
    const h = await login(env.app);
    const { conversation } = (
      await env.app.inject({ method: 'POST', url: '/api/conversations', headers: h, payload: {} })
    ).json();
    await env.app.inject({
      method: 'POST',
      url: `/api/conversations/${conversation.id}/messages`,
      headers: h,
      payload: { content: 'Я люблю краткие ответы' },
    });
    await env.ctx.runs.idle();

    const items = (await env.app.inject({ url: '/api/memory', headers: h })).json().items;
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: 'preference', content: 'Любит краткие ответы' });
    expect(items[0].source).toMatch(/^agent:chat:/);

    const patched = (
      await env.app.inject({
        method: 'PATCH',
        url: `/api/memory/${items[0].id}`,
        headers: h,
        payload: { content: 'Любит очень краткие ответы' },
      })
    ).json();
    expect(patched.item.content).toBe('Любит очень краткие ответы');

    // сохранённая память попадает в системный промпт следующих запросов
    await env.app.inject({
      method: 'POST',
      url: `/api/conversations/${conversation.id}/messages`,
      headers: h,
      payload: { content: 'ещё вопрос' },
    });
    await env.ctx.runs.idle();
    const sys = String(env.provider.calls.at(-1)!.messages[0]!.content);
    expect(sys).toContain('Любит очень краткие ответы');

    await env.app.inject({ method: 'DELETE', url: `/api/memory/${items[0].id}`, headers: h });
    expect((await env.app.inject({ url: '/api/memory', headers: h })).json().items).toHaveLength(0);
  });

  it('дубликаты не плодятся; ручное добавление работает', async () => {
    env = await createTestEnv();
    const h = await login(env.app);
    for (let i = 0; i < 2; i++)
      await env.app.inject({
        method: 'POST',
        url: '/api/memory',
        headers: h,
        payload: { kind: 'fact', content: 'Живёт в Алматы' },
      });
    expect((await env.app.inject({ url: '/api/memory', headers: h })).json().items).toHaveLength(1);
  });
});

describe('подтверждения, журнал действий и откат', () => {
  async function chat(h: Record<string, string>, text: string, id?: string) {
    const conversationId =
      id ??
      ((await env.app.inject({ method: 'POST', url: '/api/conversations', headers: h, payload: {} })).json()
        .conversation.id as string);
    const res = await env.app.inject({
      method: 'POST',
      url: `/api/conversations/${conversationId}/messages`,
      headers: h,
      payload: { content: text },
    });
    await env.ctx.runs.idle();
    return { conversationId, res };
  }
  const messages = async (h: Record<string, string>, id: string) =>
    (await env.app.inject({ url: `/api/conversations/${id}`, headers: h })).json() as {
      messages: { role: string; content: string; status: string }[];
      pendingApprovals: { id: string }[];
    };

  it('удаление файла ждёт подтверждения; после «Одобрить» выполняется, агент продолжает; откат возвращает файл', async () => {
    env = await createTestEnv({
      script: (_r, n) =>
        n === 1
          ? { content: 'Удаляю.', toolCalls: [toolCall('file_delete', { path: 'docs/a.txt' }, 'call-del')] }
          : { content: 'Файл удалён.' },
    });
    await env.ctx.files.write('docs/a.txt', 'важное содержимое');
    const h = await login(env.app);

    const { conversationId } = await chat(h, 'удали docs/a.txt');
    // действие НЕ выполнено
    expect(await env.ctx.files.exists('docs/a.txt')).toBe(true);
    let conv = await messages(h, conversationId);
    expect(conv.messages.at(-1)).toMatchObject({ role: 'tool', status: 'pending' });
    expect(conv.pendingApprovals).toHaveLength(1);
    const approvals = (await env.app.inject({ url: '/api/approvals?status=pending', headers: h })).json().items;
    expect(approvals[0]).toMatchObject({ action: 'file_delete', status: 'pending', args: { path: 'docs/a.txt' } });
    expect(approvals[0].summary).toContain('docs/a.txt');
    expect(
      (await env.app.inject({ url: '/api/notifications', headers: h }))
        .json()
        .items.some((n: { kind: string }) => n.kind === 'approval'),
    ).toBe(true);

    // пока ждём подтверждения, новые сообщения в этот чат не принимаются
    const blocked = await env.app.inject({
      method: 'POST',
      url: `/api/conversations/${conversationId}/messages`,
      headers: h,
      payload: { content: 'ещё' },
    });
    expect(blocked.statusCode).toBe(409);

    // одобряем
    const approved = await env.app.inject({
      method: 'POST',
      url: `/api/approvals/${approvals[0].id}/approve`,
      headers: h,
    });
    expect(approved.statusCode).toBe(200);
    await env.ctx.runs.idle();
    expect(await env.ctx.files.exists('docs/a.txt')).toBe(false);
    expect(await env.ctx.files.exists(`_trash/${(await env.ctx.files.list('_trash'))[0]!.name}/docs/a.txt`)).toBe(true);

    conv = await messages(h, conversationId);
    expect(conv.messages.at(-1)).toMatchObject({ role: 'assistant', content: 'Файл удалён.' });
    expect(conv.messages.find((m) => m.role === 'tool')).toMatchObject({ status: 'ok' });

    // повторное решение невозможно
    expect(
      (await env.app.inject({ method: 'POST', url: `/api/approvals/${approvals[0].id}/approve`, headers: h }))
        .statusCode,
    ).toBe(409);
    // в журнале — выполненное действие, откатываемое
    const log = (await env.app.inject({ url: '/api/actions', headers: h })).json().items;
    const entry = log.find((a: { tool: string }) => a.tool === 'file_delete');
    expect(entry).toMatchObject({ status: 'ok', undoable: true, approvalId: approvals[0].id });

    const undo = await env.app.inject({ method: 'POST', url: `/api/actions/${entry.id}/undo`, headers: h });
    expect(undo.statusCode).toBe(200);
    expect(await env.ctx.files.exists('docs/a.txt')).toBe(true);
    expect((await env.ctx.files.read('docs/a.txt'))!.toString()).toBe('важное содержимое');
    expect(
      (await env.app.inject({ method: 'POST', url: `/api/actions/${entry.id}/undo`, headers: h })).statusCode,
    ).toBe(409);
  });

  it('отклонённое действие не выполняется, модель узнаёт об отказе', async () => {
    env = await createTestEnv({
      script: (req, n) => {
        if (n === 1) return { toolCalls: [toolCall('file_delete', { path: 'keep.txt' }, 'c1')] };
        const tool = req.messages.find((m) => m.role === 'tool');
        return { content: `Понял, отказ: ${tool && 'content' in tool ? tool.content.slice(0, 30) : ''}` };
      },
    });
    await env.ctx.files.write('keep.txt', 'x');
    const h = await login(env.app);
    const { conversationId } = await chat(h, 'удали keep.txt');
    const [approval] = (await env.app.inject({ url: '/api/approvals?status=pending', headers: h })).json().items;
    const r = await env.app.inject({
      method: 'POST',
      url: `/api/approvals/${approval.id}/reject`,
      headers: h,
      payload: {},
    });
    expect(r.json().item.status).toBe('rejected');
    await env.ctx.runs.idle();
    expect(await env.ctx.files.exists('keep.txt')).toBe(true);
    const conv = await messages(h, conversationId);
    expect(conv.messages.find((m) => m.role === 'tool')).toMatchObject({ status: 'rejected' });
    expect(conv.messages.at(-1)!.content).toContain('Пользователь отклонил');
    const log = (await env.app.inject({ url: '/api/actions', headers: h })).json().items;
    expect(log.find((a: { tool: string }) => a.tool === 'file_delete')).toMatchObject({
      status: 'rejected',
      undoable: false,
    });
  });

  it('перезапись существующего файла требует подтверждения, новый файл — нет; откат возвращает прежнюю версию', async () => {
    env = await createTestEnv({
      script: (_r, n) => {
        if (n === 1) return { toolCalls: [toolCall('file_write', { path: 'new.txt', content: 'v1' }, 'a')] };
        if (n === 2) return { content: 'создал' };
        if (n === 3) return { toolCalls: [toolCall('file_write', { path: 'new.txt', content: 'v2' }, 'b')] };
        return { content: 'перезаписал' };
      },
    });
    const h = await login(env.app);
    const { conversationId } = await chat(h, 'создай new.txt');
    expect((await env.ctx.files.read('new.txt'))!.toString()).toBe('v1'); // без подтверждения

    await chat(h, 'перезапиши new.txt', conversationId);
    expect((await env.ctx.files.read('new.txt'))!.toString()).toBe('v1'); // ещё не перезаписан
    const [approval] = (await env.app.inject({ url: '/api/approvals?status=pending', headers: h })).json().items;
    expect(approval.summary).toContain('Перезапись');
    await env.app.inject({ method: 'POST', url: `/api/approvals/${approval.id}/approve`, headers: h });
    await env.ctx.runs.idle();
    expect((await env.ctx.files.read('new.txt'))!.toString()).toBe('v2');

    const entry = (await env.app.inject({ url: '/api/actions?tool=file_write', headers: h }))
      .json()
      .items.find((a: { summary: string }) => a.summary.includes('Перезаписан'));
    await env.app.inject({ method: 'POST', url: `/api/actions/${entry.id}/undo`, headers: h });
    expect((await env.ctx.files.read('new.txt'))!.toString()).toBe('v1');
  });

  it('журнал не содержит секретов из аргументов инструментов', async () => {
    const { z } = await import('zod');
    const { defineTool } = await import('../src/tools/types.js');
    env = await createTestEnv({
      extraTools: [
        defineTool({
          name: 'secret_probe',
          description: 'test',
          schema: z.object({ query: z.string(), apiKey: z.string() }),
          describe: (a) => `probe ${a.query} ключ ${a.apiKey}`,
          execute: async () => ({ content: 'ok', summary: 'ok sk-' + 'q'.repeat(30) }),
        }),
      ],
      script: (_r, n) =>
        n === 1
          ? { toolCalls: [toolCall('secret_probe', { query: 'погода', apiKey: 'SUPER-SECRET-VALUE' })] }
          : { content: 'готово' },
    });
    const h = await login(env.app);
    await chat(h, 'проверь');
    const raw = JSON.stringify(await env.ctx.db.query('select * from actions_log'));
    expect(raw).not.toContain('SUPER-SECRET-VALUE');
    expect(raw).not.toContain('sk-qqqq');
    expect(raw).toContain('погода');
  });

  it('неизвестный инструмент и неверные аргументы возвращаются модели как ошибка, цикл продолжается', async () => {
    env = await createTestEnv({
      script: (_r, n) =>
        n === 1
          ? { toolCalls: [toolCall('no_such_tool', {}, 'x1'), toolCall('note_create', { title: 5 }, 'x2')] }
          : { content: 'исправлюсь' },
    });
    const h = await login(env.app);
    const { conversationId } = await chat(h, 'тест ошибок');
    const conv = await messages(h, conversationId);
    const tools = conv.messages.filter((m) => m.role === 'tool');
    expect(tools).toHaveLength(2);
    expect(tools[0]).toMatchObject({ status: 'error', content: expect.stringContaining('Неизвестный инструмент') });
    expect(tools[1]).toMatchObject({ status: 'error', content: expect.stringContaining('неверные аргументы') });
    expect(conv.messages.at(-1)!.content).toBe('исправлюсь');
  });

  it('лимит шагов останавливает зацикливание', async () => {
    env = await createTestEnv({
      config: { AGENT_MAX_STEPS: '3' },
      script: () => ({ toolCalls: [toolCall('get_time', {})] }),
    });
    const h = await login(env.app);
    const { conversationId } = await chat(h, 'зациклись');
    expect(env.provider.calls).toHaveLength(3);
    const conv = await messages(h, conversationId);
    expect(conv.messages.at(-1)!.content).toContain('лимит шагов');
  });
});

describe('бюджет', () => {
  it('покомандный лимит токенов — жёсткий стоп', async () => {
    env = await createTestEnv({
      config: { BUDGET_RUN_TOKENS: '300', AGENT_MAX_STEPS: '20' },
      script: () => ({ toolCalls: [toolCall('get_time', {})], usage: { promptTokens: 100, completionTokens: 20 } }),
    });
    const h = await login(env.app);
    const { conversation } = (
      await env.app.inject({ method: 'POST', url: '/api/conversations', headers: h, payload: {} })
    ).json();
    await env.app.inject({
      method: 'POST',
      url: `/api/conversations/${conversation.id}/messages`,
      headers: h,
      payload: { content: 'крути цикл' },
    });
    await env.ctx.runs.idle();
    expect(env.provider.calls).toHaveLength(3); // 3 × 120 = 360 ≥ 300 → стоп перед 4-м запросом
    const got = (await env.app.inject({ url: `/api/conversations/${conversation.id}`, headers: h })).json();
    expect(got.messages.at(-1).content).toContain('Бюджет исчерпан');
  });

  it('дневной лимит блокирует запросы в любом чате', async () => {
    env = await createTestEnv({ config: { BUDGET_DAILY_TOKENS: '100' }, script: () => ({ content: 'ок' }) });
    const h = await login(env.app);
    const send = async (text: string) => {
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
      return (await env.app.inject({ url: `/api/conversations/${conversation.id}`, headers: h })).json().messages.at(-1)
        .content as string;
    };
    expect(await send('первый')).toBe('ок'); // 120 токенов ≥ 100
    expect(env.provider.calls).toHaveLength(1);
    expect(await send('второй')).toContain('Бюджет исчерпан');
    expect(env.provider.calls).toHaveLength(1); // модель не вызывалась
  });

  it('денежный лимит и настройка лимитов через API', async () => {
    env = await createTestEnv({
      script: () => ({ content: 'ок', usage: { promptTokens: 10, completionTokens: 10, costUsd: 0.6 } }),
    });
    const h = await login(env.app);
    const put = await env.app.inject({
      method: 'PUT',
      url: '/api/budget',
      headers: h,
      payload: { dailyTokens: 0, dailyUsd: 0.5, runTokens: 0, runUsd: 0 },
    });
    expect(put.json().limits).toMatchObject({ dailyUsd: 0.5, dailyTokens: 0 });
    const { conversation } = (
      await env.app.inject({ method: 'POST', url: '/api/conversations', headers: h, payload: {} })
    ).json();
    const say = async (t: string) => {
      await env.app.inject({
        method: 'POST',
        url: `/api/conversations/${conversation.id}/messages`,
        headers: h,
        payload: { content: t },
      });
      await env.ctx.runs.idle();
    };
    await say('раз');
    await say('два');
    const msgs = (await env.app.inject({ url: `/api/conversations/${conversation.id}`, headers: h })).json().messages;
    expect(msgs.at(-1).content).toMatch(/Бюджет исчерпан.*долларов/);
    expect(env.provider.calls).toHaveLength(1);
    const budget = (await env.app.inject({ url: '/api/budget', headers: h })).json();
    expect(budget.daily.usd).toBeCloseTo(0.6);
    expect(budget.byProvider[0]).toMatchObject({ provider: 'openrouter', calls: 1 });
  });
});
