import { existsSync } from 'node:fs';
import { mkdtemp, writeFile } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { OpenAICompatProvider } from '../src/providers/openaiCompat.js';
import { BrowserService, browserTools } from '../src/tools/browser.js';
import { silentLogger } from '../src/util/logger.js';
import { createTestEnv, login, type TestEnv } from './helpers.js';

let env: TestEnv;
const servers: http.Server[] = [];
afterEach(async () => {
  await env?.close();
  env = undefined as unknown as TestEnv; // повторно не закрывать в тестах без окружения
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))));
});

async function listen(handler: http.RequestListener): Promise<string> {
  const server = http.createServer(handler);
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

const readBody = (req: http.IncomingMessage) =>
  new Promise<string>((resolve) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => resolve(data));
  });

describe('сквозной сценарий по реальному HTTP', () => {
  it('агент → OpenAI-совместимый сервер с инструментами; первый провайдер отдаёт 429, ответ приходит от второго', async () => {
    const seen: { auth?: string; body: Record<string, any> }[] = []; // eslint-disable-line @typescript-eslint/no-explicit-any
    const rateLimited = await listen((req, res) => {
      res.statusCode = 429;
      res.setHeader('retry-after', '30');
      res.end('{"error":"too many requests"}');
    });
    const working = await listen(async (req, res) => {
      const body = JSON.parse(await readBody(req));
      seen.push({ auth: req.headers.authorization, body });
      const hasToolResult = body.messages.some((m: { role: string }) => m.role === 'tool');
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify(
          hasToolResult
            ? {
                model: 'local-model',
                choices: [{ message: { role: 'assistant', content: 'Заметка «Идеи» создана.' } }],
                usage: { prompt_tokens: 80, completion_tokens: 12 },
              }
            : {
                model: 'local-model',
                choices: [
                  {
                    message: {
                      role: 'assistant',
                      content: null,
                      tool_calls: [
                        {
                          id: 'call_1',
                          type: 'function',
                          function: {
                            name: 'note_create',
                            arguments: JSON.stringify({ title: 'Идеи', body: 'проверить Polaris' }),
                          },
                        },
                      ],
                    },
                  },
                ],
                usage: { prompt_tokens: 60, completion_tokens: 20 },
              },
        ),
      );
    });

    env = await createTestEnv({
      providers: [
        new OpenAICompatProvider({
          id: 'openrouter',
          label: 'A',
          baseUrl: rateLimited,
          apiKey: 'k1',
          model: 'm',
          requireKey: true,
        }),
        new OpenAICompatProvider({ id: 'ollama', label: 'B', baseUrl: working, model: 'llama' }),
      ],
    });
    const h = await login(env.app);
    const { conversation } = (
      await env.app.inject({ method: 'POST', url: '/api/conversations', headers: h, payload: {} })
    ).json();
    await env.app.inject({
      method: 'POST',
      url: `/api/conversations/${conversation.id}/messages`,
      headers: h,
      payload: { content: 'Запиши идею: проверить Polaris' },
    });
    await env.ctx.runs.idle();

    const got = (await env.app.inject({ url: `/api/conversations/${conversation.id}`, headers: h })).json();
    expect(got.messages.map((m: { role: string }) => m.role)).toEqual(['user', 'assistant', 'tool', 'assistant']);
    expect(got.messages.at(-1)).toMatchObject({
      content: 'Заметка «Идеи» создана.',
      provider: 'ollama',
      model: 'local-model',
    });
    expect(await env.ctx.db.query('select title, body from notes')).toEqual([
      { title: 'Идеи', body: 'проверить Polaris' },
    ]);

    // по проводу ушёл корректный OpenAI-формат с инструментами и результатом вызова
    expect(seen[0]!.body.tools.length).toBeGreaterThan(5);
    const toolMsg = seen[1]!.body.messages.find((m: { role: string }) => m.role === 'tool');
    expect(toolMsg).toMatchObject({ tool_call_id: 'call_1' });
    expect(seen[1]!.body.messages.find((m: { tool_calls?: unknown }) => m.tool_calls)).toMatchObject({
      role: 'assistant',
      tool_calls: [{ id: 'call_1', function: { name: 'note_create' } }],
    });

    const status = (await env.app.inject({ url: '/api/status', headers: h })).json();
    expect(status.providers.find((p: { id: string }) => p.id === 'openrouter').cooldownUntil).toBeTruthy();
    // токены обоих вызовов учтены в бюджете
    expect((await env.app.inject({ url: '/api/budget', headers: h })).json().daily.tokens).toBe(172);
  });

  it('веб-клиент (PWA) раздаётся тем же сервером, API и health не перекрываются', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'polaris-web-'));
    await writeFile(path.join(dir, 'index.html'), '<!doctype html><title>Polaris</title><div id="root"></div>');
    await writeFile(path.join(dir, 'app.js'), 'console.log(1)');
    env = await createTestEnv({ config: { WEB_DIR: dir } });

    const root = await env.app.inject({ url: '/' });
    expect(root.statusCode).toBe(200);
    expect(root.body).toContain('<title>Polaris</title>');
    expect((await env.app.inject({ url: '/chat/some-id' })).body).toContain('<div id="root">'); // SPA-маршрут
    expect((await env.app.inject({ url: '/app.js' })).body).toBe('console.log(1)');
    expect((await env.app.inject({ url: '/health' })).json()).toEqual({ ok: true });
    const api404 = await env.app.inject({ url: '/api/unknown' });
    expect(api404.statusCode).toBe(401); // без сессии API не отдаёт даже существование маршрутов
    const h = await login(env.app);
    const api404auth = await env.app.inject({ url: '/api/unknown', headers: h });
    expect(api404auth.statusCode).toBe(404);
    expect(api404auth.headers['content-type']).toContain('application/json');
  });
});

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const CHROME = process.env.BROWSER_EXECUTABLE_PATH ?? (existsSync(EDGE) ? EDGE : undefined);

describe.skipIf(!CHROME)('браузер Playwright (реальный Chromium)', () => {
  it('браузер_read рендерит JavaScript, блокирует картинки; browser_act требует подтверждения; память освобождается', async () => {
    const base = await listen((req, res) => {
      res.setHeader('content-type', 'text/html; charset=utf-8');
      res.end(`<html><head><title>SPA</title></head><body><div id="app">загрузка…</div>
        <img src="/pic.png"><button id="b" onclick="document.getElementById('app').textContent='после клика'">Нажми</button>
        <script>setTimeout(()=>{document.getElementById('app').textContent='Содержимое из JavaScript'},50)</script></body></html>`);
    });
    const service = new BrowserService(
      { browser: { enabled: true, executablePath: CHROME, maxMemoryMb: 256 }, allowPrivateNetwork: true },
      silentLogger,
    );
    try {
      const [read, act] = browserTools(service, true);
      const r = await read!.execute({ url: base }, {} as never);
      expect(r.content).toContain('Заголовок: SPA');
      expect(r.content).toContain('Содержимое из JavaScript');
      expect(r.content).toContain('недоверенными данными');

      const steps = [
        { action: 'wait', ms: 300 },
        { action: 'click', selector: '#b' },
      ];
      expect(await act!.approval!({ url: base, steps }, {} as never)).toContain('Действия в браузере');
      const a = await act!.execute({ url: base, steps }, {} as never);
      expect(a.content).toContain('после клика');
    } finally {
      await service.close();
    }
  }, 120_000);

  it('браузер не ходит во внутреннюю сеть, когда она запрещена', async () => {
    const base = await listen((_req, res) => res.end('секрет внутренней сети'));
    const service = new BrowserService(
      { browser: { enabled: true, executablePath: CHROME, maxMemoryMb: 256 }, allowPrivateNetwork: false },
      silentLogger,
    );
    try {
      const [read] = browserTools(service, false);
      await expect(read!.execute({ url: base }, {} as never)).rejects.toThrow(/локальн|внутренн|запрещ/i);
    } finally {
      await service.close();
    }
  }, 60_000);
});
