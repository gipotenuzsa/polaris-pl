import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildAuthorizeUrl, extractClaims, generatePkce, parseCallbackInput } from '../src/providers/chatgpt/oauth.js';
import { ChatGptProvider } from '../src/providers/chatgpt/provider.js';
import { createTestEnv, type TestEnv } from './helpers.js';

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
export const fakeJwt = (exp: number, extra: Record<string, unknown> = {}) =>
  `${b64({ alg: 'none' })}.${b64({ exp, email: 'me@example.com', 'https://api.openai.com/auth': { chatgpt_account_id: 'acct_123', chatgpt_plan_type: 'plus' }, ...extra })}.sig`;

const inFuture = (sec: number) => Math.floor(Date.now() / 1000) + sec;
const jsonRes = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });
const sseRes = (events: unknown[]) =>
  new Response(events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join(''), {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
const okStream = (text = 'ok') =>
  sseRes([
    { type: 'response.output_item.done', item: { type: 'message', content: [{ type: 'output_text', text }] } },
    { type: 'response.completed', response: { model: 'gpt-6-luna', usage: { input_tokens: 5, output_tokens: 1 } } },
  ]);

describe('OAuth ChatGPT: чистые функции', () => {
  it('PKCE: challenge = base64url(sha256(verifier))', () => {
    const { verifier, challenge } = generatePkce();
    expect(challenge).toBe(createHash('sha256').update(verifier).digest('base64url'));
    expect(verifier.length).toBeGreaterThanOrEqual(43);
  });

  it('ссылка авторизации содержит все параметры потока Codex', async () => {
    const env = await createTestEnv();
    const url = new URL(buildAuthorizeUrl(env.ctx.config.providers.chatgpt, 'ST', 'CH'));
    expect(url.origin + url.pathname).toBe('https://auth.openai.com/oauth/authorize');
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      response_type: 'code',
      client_id: 'app_EMoamEEZ73f0CkXaXp7hrann',
      redirect_uri: 'http://localhost:1455/auth/callback',
      code_challenge: 'CH',
      code_challenge_method: 'S256',
      state: 'ST',
      codex_cli_simplified_flow: 'true',
      id_token_add_organizations: 'true',
    });
    expect(url.searchParams.get('scope')).toContain('offline_access');
    await env.close();
  });

  it('разбирает вставленный адрес: полный URL, query и ошибки', () => {
    expect(parseCallbackInput('http://localhost:1455/auth/callback?code=abc&state=xyz')).toEqual({
      code: 'abc',
      state: 'xyz',
    });
    expect(parseCallbackInput('?code=abc&state=xyz')).toEqual({ code: 'abc', state: 'xyz' });
    expect(parseCallbackInput('  code=abc  ')).toEqual({ code: 'abc', state: undefined });
    expect(() => parseCallbackInput('')).toThrow();
    expect(() => parseCallbackInput('http://localhost:1455/auth/callback')).toThrow(/code/);
    expect(() => parseCallbackInput('http://localhost:1455/auth/callback?error=access_denied')).toThrow(
      /access_denied/,
    );
  });

  it('достаёт accountId, e-mail и срок из JWT', () => {
    const c = extractClaims(fakeJwt(1234));
    expect(c).toMatchObject({ accountId: 'acct_123', email: 'me@example.com', plan: 'plus', exp: 1234 });
    expect(extractClaims('мусор', undefined)).toEqual({});
  });
});

describe('ChatGptAuth и провайдер', () => {
  let env: TestEnv;
  afterEach(async () => env?.close());

  async function setup(handlers: {
    token?: (body: string, init: RequestInit) => Response;
    responses?: (init: RequestInit) => Response;
  }) {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchMock = vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
      const url = String(input);
      calls.push({ url, init });
      if (url.endsWith('/oauth/token')) return handlers.token!(String(init.body), init);
      if (url.endsWith('/responses')) return handlers.responses!(init);
      throw new Error(`неожиданный запрос ${url}`);
    });
    env = await createTestEnv({ fetch: fetchMock as unknown as typeof fetch });
    return { calls };
  }

  async function connect() {
    const { authUrl, state } = await env.ctx.chatgpt.startFlow();
    const challenge = new URL(authUrl).searchParams.get('code_challenge')!;
    const status = await env.ctx.chatgpt.completeFlow(
      `http://localhost:1455/auth/callback?code=THECODE&state=${state}`,
    );
    return { challenge, status };
  }

  it('полный вход: обмен кода по PKCE, токены шифруются в БД', async () => {
    const access = fakeJwt(inFuture(3600));
    const { calls } = await setup({
      token: () => jsonRes({ access_token: access, refresh_token: 'REFRESH1', id_token: fakeJwt(inFuture(3600)) }),
    });

    expect((await env.ctx.chatgpt.status()).connected).toBe(false);
    const { challenge, status } = await connect();

    const form = new URLSearchParams(String(calls[0]!.init.body));
    expect(form.get('grant_type')).toBe('authorization_code');
    expect(form.get('code')).toBe('THECODE');
    expect(form.get('client_id')).toBe('app_EMoamEEZ73f0CkXaXp7hrann');
    expect(createHash('sha256').update(form.get('code_verifier')!).digest('base64url')).toBe(challenge);

    expect(status).toMatchObject({ connected: true, accountId: 'acct_123', email: 'me@example.com', plan: 'plus' });
    const row = (
      await env.ctx.db.query<{ encrypted_token: string; account_id: string }>('select * from provider_credentials')
    )[0]!;
    expect(row.encrypted_token).not.toContain('REFRESH1');
    expect(row.encrypted_token).not.toContain(access.slice(10, 40));
    expect(row.account_id).toBe('acct_123');
    expect(await env.ctx.db.query('select * from oauth_flows')).toHaveLength(0);
  });

  it('чужой state и повторное использование кода отклоняются', async () => {
    await setup({ token: () => jsonRes({ access_token: fakeJwt(inFuture(3600)), refresh_token: 'R' }) });
    await env.ctx.chatgpt.startFlow();
    await expect(
      env.ctx.chatgpt.completeFlow('http://localhost:1455/auth/callback?code=c&state=WRONG'),
    ).rejects.toThrow(/не найдена/);
    await expect(env.ctx.chatgpt.completeFlow('http://localhost:1455/auth/callback?code=c')).resolves.toBeTruthy(); // без state — последняя сессия
    await expect(env.ctx.chatgpt.completeFlow('http://localhost:1455/auth/callback?code=c')).rejects.toThrow(
      /не найдена/,
    );
  });

  it('ошибка обмена у OpenAI даёт понятное сообщение', async () => {
    await setup({ token: () => jsonRes({ error: 'invalid_grant', error_description: 'code expired' }, 400) });
    const { state } = await env.ctx.chatgpt.startFlow();
    await expect(env.ctx.chatgpt.completeFlow(`?code=x&state=${state}`)).rejects.toThrow(/invalid_grant/);
    expect((await env.ctx.chatgpt.status()).connected).toBe(false);
  });

  it('«Проверить вход» делает реальный запрос с нужными заголовками и телом', async () => {
    const { calls } = await setup({
      token: () =>
        jsonRes({ access_token: fakeJwt(inFuture(3600)), refresh_token: 'R', id_token: fakeJwt(inFuture(3600)) }),
      responses: () => okStream(),
    });
    await connect();
    const res = await env.ctx.chatgpt.check();
    expect(res).toMatchObject({ ok: true, model: 'gpt-6-luna' });

    const call = calls.find((c) => c.url.endsWith('/responses'))!;
    expect(call.url).toBe('https://chatgpt.com/backend-api/codex/responses');
    const h = call.init.headers as Record<string, string>;
    expect(h.authorization).toMatch(/^Bearer ey/);
    expect(h['chatgpt-account-id']).toBe('acct_123');
    expect(h['openai-beta']).toBe('responses=experimental');
    expect(h.originator).toBe('codex_cli_rs');
    const body = JSON.parse(String(call.init.body));
    expect(body).toMatchObject({ model: 'gpt-6-luna', stream: true, store: false });
    expect(body.instructions).toBeTruthy();
    expect(body.input[0]).toEqual({
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: expect.stringContaining('ok') }],
    });
  });

  it('model_not_found распознаётся и сообщается пользователю', async () => {
    await setup({
      token: () => jsonRes({ access_token: fakeJwt(inFuture(3600)), refresh_token: 'R' }),
      responses: () =>
        sseRes([
          {
            type: 'response.failed',
            response: { error: { code: 'model_not_found', message: 'The model does not exist' } },
          },
        ]),
    });
    await connect();
    expect(await env.ctx.chatgpt.check()).toMatchObject({ ok: false, modelNotFound: true });
  });

  it('без подключения проверка честно сообщает об этом', async () => {
    await setup({});
    expect(await env.ctx.chatgpt.check()).toMatchObject({ ok: false, error: expect.stringContaining('не подключён') });
  });

  it('истекающий токен обновляется одним запросом даже при параллельных вызовах', async () => {
    let refreshes = 0;
    await setup({
      token: (body) => {
        if (body.includes('refresh_token')) {
          refreshes++;
          expect(JSON.parse(body)).toMatchObject({
            grant_type: 'refresh_token',
            refresh_token: 'R1',
            client_id: 'app_EMoamEEZ73f0CkXaXp7hrann',
          });
          return jsonRes({ access_token: fakeJwt(inFuture(7200)), refresh_token: 'R2' });
        }
        return jsonRes({ access_token: fakeJwt(inFuture(60)), refresh_token: 'R1', id_token: fakeJwt(inFuture(60)) }); // почти истёк
      },
    });
    await connect();
    const results = await Promise.all([
      env.ctx.chatgpt.getAccess(),
      env.ctx.chatgpt.getAccess(),
      env.ctx.chatgpt.getAccess(),
    ]);
    expect(refreshes).toBe(1);
    expect(results.every((r) => r.accountId === 'acct_123')).toBe(true);
    await env.ctx.chatgpt.getAccess(); // свежий токен — обновления нет
    expect(refreshes).toBe(1);
  });

  it('401 от бэкенда → принудительное обновление и один повтор', async () => {
    let n = 0;
    await setup({
      token: (body) =>
        body.includes('refresh_token')
          ? jsonRes({ access_token: fakeJwt(inFuture(3600), { v: 'new' }), refresh_token: 'R2' })
          : jsonRes({ access_token: fakeJwt(inFuture(3600)), refresh_token: 'R1', id_token: fakeJwt(inFuture(3600)) }),
      responses: () => (++n === 1 ? new Response('expired', { status: 401 }) : okStream('после обновления')),
    });
    await connect();
    await env.ctx.chatgpt.setEnabled(true);
    const res = await new ChatGptProvider(env.ctx).chat({ messages: [{ role: 'user', content: 'hi' }] });
    expect(res.content).toBe('после обновления');
    expect(n).toBe(2);
  });

  it('провайдер доступен только когда включён и подключён; отключение стирает токены', async () => {
    await setup({ token: () => jsonRes({ access_token: fakeJwt(inFuture(3600)), refresh_token: 'R' }) });
    const p = new ChatGptProvider(env.ctx);
    expect(await p.isAvailable()).toBe(false);
    await connect();
    expect(await p.isAvailable()).toBe(false); // подключён, но не включён в настройках
    await env.ctx.chatgpt.setEnabled(true);
    expect(await p.isAvailable()).toBe(true);
    await env.ctx.chatgpt.setModel('gpt-5-codex');
    expect(await p.currentModel()).toBe('gpt-5-codex');
    await env.ctx.chatgpt.disconnect();
    expect(await p.isAvailable()).toBe(false);
    expect(await env.ctx.db.query('select * from provider_credentials')).toHaveLength(0);
  });

  it('история с вызовами инструментов конвертируется в формат Responses', async () => {
    const { calls } = await setup({
      token: () => jsonRes({ access_token: fakeJwt(inFuture(3600)), refresh_token: 'R' }),
      responses: () => okStream(),
    });
    await connect();
    await new ChatGptProvider(env.ctx).chat({
      messages: [
        { role: 'system', content: 'ИНСТРУКЦИЯ' },
        { role: 'user', content: 'создай' },
        {
          role: 'assistant',
          content: 'делаю',
          toolCalls: [{ id: 'c1', name: 'note_create', arguments: { title: 'a' } }],
        },
        { role: 'tool', toolCallId: 'c1', name: 'note_create', content: 'создано' },
      ],
      tools: [{ name: 'note_create', description: 'd', parameters: { type: 'object', properties: {} } }],
    });
    const body = JSON.parse(String(calls.find((c) => c.url.endsWith('/responses'))!.init.body));
    expect(body.instructions).toBe('ИНСТРУКЦИЯ');
    expect(body.input.map((i: { type: string }) => i.type)).toEqual([
      'message',
      'message',
      'function_call',
      'function_call_output',
    ]);
    expect(body.input[2]).toEqual({
      type: 'function_call',
      call_id: 'c1',
      name: 'note_create',
      arguments: '{"title":"a"}',
    });
    expect(body.input[3]).toEqual({ type: 'function_call_output', call_id: 'c1', output: 'создано' });
    expect(body.tools[0]).toMatchObject({ type: 'function', name: 'note_create', strict: false });
  });
});
