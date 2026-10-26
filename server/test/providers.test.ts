import { describe, expect, it, vi } from 'vitest';
import { AllProvidersFailedError, ProviderChain } from '../src/providers/chain.js';
import { GeminiProvider, toGeminiContents, toGeminiSchema } from '../src/providers/gemini.js';
import { OpenAICompatProvider } from '../src/providers/openaiCompat.js';
import { parseSse } from '../src/providers/sse.js';
import { ProviderError, type ChatMessage } from '../src/providers/types.js';
import { collectResponse } from '../src/providers/chatgpt/responses.js';
import { silentLogger } from '../src/util/logger.js';
import { ScriptedProvider } from './helpers.js';

const json = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' }, ...init });

const tools = [
  {
    name: 'note_create',
    description: 'Создать заметку',
    parameters: {
      type: 'object',
      properties: { title: { type: 'string' } },
      required: ['title'],
      additionalProperties: false,
    },
  },
];

describe('OpenAI-совместимый провайдер (OpenRouter / Ollama)', () => {
  it('отправляет tools и ключ, разбирает вызовы инструментов и стоимость', async () => {
    const fetchMock = vi.fn(async () =>
      json({
        model: 'openai/test',
        choices: [
          {
            message: {
              content: null,
              tool_calls: [{ id: 'c1', function: { name: 'note_create', arguments: '{"title":"Привет"}' } }],
            },
          },
        ],
        usage: { prompt_tokens: 50, completion_tokens: 10, cost: 0.0012 },
      }),
    );
    const p = new OpenAICompatProvider({
      id: 'openrouter',
      label: 'OR',
      baseUrl: 'https://or.test/api/v1/',
      model: 'm',
      apiKey: 'KEY',
      requireKey: true,
      includeCost: true,
      fetch: fetchMock as unknown as typeof fetch,
    });
    const res = await p.chat({
      messages: [
        { role: 'system', content: 's' },
        { role: 'user', content: 'u' },
      ],
      tools,
      maxTokens: 500,
    });

    expect(res.toolCalls).toEqual([{ id: 'c1', name: 'note_create', arguments: { title: 'Привет' } }]);
    expect(res.usage).toEqual({ promptTokens: 50, completionTokens: 10, costUsd: 0.0012 });

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://or.test/api/v1/chat/completions');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer KEY');
    const body = JSON.parse(init.body as string);
    expect(body.tools[0]).toEqual({ type: 'function', function: expect.objectContaining({ name: 'note_create' }) });
    expect(body.max_tokens).toBe(500);
    expect(body.usage).toEqual({ include: true });
  });

  it('передаёт историю с вызовами и результатами инструментов', async () => {
    const fetchMock = vi.fn(async () => json({ choices: [{ message: { content: 'готово' } }], usage: {} }));
    const p = new OpenAICompatProvider({
      id: 'ollama',
      label: 'O',
      baseUrl: 'http://x/v1',
      model: 'm',
      fetch: fetchMock as unknown as typeof fetch,
    });
    const history: ChatMessage[] = [
      { role: 'user', content: 'создай' },
      { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'note_create', arguments: { title: 'a' } }] },
      { role: 'tool', toolCallId: 'c1', name: 'note_create', content: 'ok' },
    ];
    await p.chat({ messages: history });
    const body = JSON.parse((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
    expect(body.messages[1]).toEqual({
      role: 'assistant',
      content: null,
      tool_calls: [{ id: 'c1', type: 'function', function: { name: 'note_create', arguments: '{"title":"a"}' } }],
    });
    expect(body.messages[2]).toEqual({ role: 'tool', tool_call_id: 'c1', content: 'ok' });
  });

  it('429 → rate_limit с Retry-After; 5xx → server; ошибка в теле 200 → ошибка', async () => {
    const mk = (res: () => Response) =>
      new OpenAICompatProvider({
        id: 'openrouter',
        label: 'x',
        baseUrl: 'http://x',
        model: 'm',
        apiKey: 'k',
        fetch: (async () => res()) as unknown as typeof fetch,
      });
    const e429 = await mk(() => new Response('slow down', { status: 429, headers: { 'retry-after': '7' } }))
      .chat({ messages: [] })
      .catch((e) => e);
    expect(e429).toBeInstanceOf(ProviderError);
    expect(e429).toMatchObject({ kind: 'rate_limit', status: 429, retryAfterMs: 7000 });
    const e500 = await mk(() => new Response('boom', { status: 502 }))
      .chat({ messages: [] })
      .catch((e) => e);
    expect(e500.kind).toBe('server');
    const eBody = await mk(() => json({ error: { code: 429, message: 'quota' } }))
      .chat({ messages: [] })
      .catch((e) => e);
    expect(eBody.kind).toBe('rate_limit');
    const empty = await mk(() => json({ choices: [{ message: { content: '' } }] }))
      .chat({ messages: [] })
      .catch((e) => e);
    expect(empty.kind).toBe('empty');
  });

  it('сообщение об ошибке не содержит секретов из тела ответа', async () => {
    const p = new OpenAICompatProvider({
      id: 'openrouter',
      label: 'x',
      baseUrl: 'http://x',
      model: 'm',
      apiKey: 'k',
      fetch: (async () => new Response('bad key sk-' + 'z'.repeat(40), { status: 401 })) as unknown as typeof fetch,
    });
    const err = (await p.chat({ messages: [] }).catch((e) => e)) as Error;
    expect(err.message).not.toContain('sk-zzzz');
  });

  it('ненастроенный OpenRouter (без ключа) недоступен', () => {
    const p = new OpenAICompatProvider({
      id: 'openrouter',
      label: 'x',
      baseUrl: 'http://x',
      model: 'm',
      requireKey: true,
    });
    expect(p.isAvailable()).toBe(false);
  });

  it('таймаут/обрыв превращаются в ProviderError', async () => {
    const p = new OpenAICompatProvider({
      id: 'openrouter',
      label: 'x',
      baseUrl: 'http://x',
      model: 'm',
      apiKey: 'k',
      fetch: (async () => {
        throw Object.assign(new Error('t'), { name: 'TimeoutError' });
      }) as unknown as typeof fetch,
    });
    expect(await p.chat({ messages: [] }).catch((e) => e.kind)).toBe('timeout');
    const p2 = new OpenAICompatProvider({
      id: 'openrouter',
      label: 'x',
      baseUrl: 'http://x',
      model: 'm',
      apiKey: 'k',
      fetch: (async () => {
        throw new TypeError('fetch failed');
      }) as unknown as typeof fetch,
    });
    expect(await p2.chat({ messages: [] }).catch((e) => e.kind)).toBe('network');
  });
});

describe('Gemini', () => {
  it('объединяет результаты инструментов и сохраняет thoughtSignature', () => {
    const messages: ChatMessage[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'hi' },
      {
        role: 'assistant',
        content: '',
        toolCalls: [
          { id: 'a', name: 't1', arguments: { x: 1 }, meta: { thoughtSignature: 'SIG' } },
          { id: 'b', name: 't2', arguments: {} },
        ],
      },
      { role: 'tool', toolCallId: 'a', name: 't1', content: 'r1' },
      { role: 'tool', toolCallId: 'b', name: 't2', content: 'r2' },
    ];
    const { system, contents } = toGeminiContents(messages, 'gemini-3-pro');
    expect(system).toBe('sys');
    expect(contents).toHaveLength(3);
    expect(contents[1]!.role).toBe('model');
    expect(contents[1]!.parts[0]).toMatchObject({ functionCall: { name: 't1' }, thoughtSignature: 'SIG' });
    expect(contents[1]!.parts[1]).toMatchObject({
      functionCall: { name: 't2' },
      thoughtSignature: 'skip_thought_signature_validator',
    });
    expect(contents[2]!.parts).toHaveLength(2); // два functionResponse в одном ходе
    expect(toGeminiContents(messages, 'gemini-2.5-flash').contents[1]!.parts[1]).not.toHaveProperty('thoughtSignature');
  });

  it('очищает JSON-схему под подмножество Gemini', () => {
    const s = toGeminiSchema({
      type: 'object',
      additionalProperties: false,
      $schema: 'x',
      properties: {
        a: { type: 'string', default: 'z', description: 'd' },
        b: { type: 'array', items: { type: 'object', additionalProperties: false, properties: {} } },
      },
      required: ['a'],
    });
    expect(JSON.stringify(s)).not.toMatch(/additionalProperties|\$schema|default/);
    expect(s).toMatchObject({ type: 'object', required: ['a'] });
  });

  it('разбирает ответ: пропускает мысли, собирает functionCall и usage', async () => {
    const fetchMock = vi.fn(async () =>
      json({
        candidates: [
          {
            content: {
              parts: [
                { text: 'думаю', thought: true },
                { text: 'Вот ' },
                { text: 'ответ' },
                { functionCall: { name: 'note_create', args: { title: 't' } }, thoughtSignature: 'S1' },
              ],
            },
          },
        ],
        usageMetadata: { promptTokenCount: 30, candidatesTokenCount: 5, thoughtsTokenCount: 4 },
      }),
    );
    const p = new GeminiProvider({
      apiKey: 'G',
      model: 'gemini-2.5-flash',
      fetch: fetchMock as unknown as typeof fetch,
    });
    const res = await p.chat({ messages: [{ role: 'user', content: 'x' }], tools, maxTokens: 100 });
    expect(res.content).toBe('Вот ответ');
    expect(res.toolCalls[0]).toMatchObject({
      name: 'note_create',
      arguments: { title: 't' },
      meta: { thoughtSignature: 'S1' },
    });
    expect(res.usage).toEqual({ promptTokens: 30, completionTokens: 9 });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain('/models/gemini-2.5-flash:generateContent');
    expect((init.headers as Record<string, string>)['x-goog-api-key']).toBe('G');
    expect(url).not.toContain('G'); // ключ не в URL
    expect(JSON.parse(init.body as string).generationConfig).toEqual({ maxOutputTokens: 100 });
  });
});

describe('цепочка провайдеров с фолбэком', () => {
  const mkChain = (providers: ScriptedProvider[], now = { t: 0 }) =>
    new ProviderChain(providers, { timeoutMs: 1000, log: silentLogger, now: () => now.t });

  it('при 429 уходит к следующему и ставит первого на паузу', async () => {
    const now = { t: 1_000 };
    const a = new ScriptedProvider(
      'openrouter',
      () => new ProviderError('openrouter', 'rate_limit', '429', 429, 60_000),
    );
    const b = new ScriptedProvider('gemini', () => ({ content: 'от gemini' }));
    const chain = mkChain([a, b], now);

    const r1 = await chain.chat({ messages: [] });
    expect(r1.provider).toBe('gemini');
    expect(r1.attempts.map((x) => [x.provider, x.ok, x.kind])).toEqual([
      ['openrouter', false, 'rate_limit'],
      ['gemini', true, undefined],
    ]);

    // Пока идёт пауза — первый не дёргаем
    now.t += 1000;
    await chain.chat({ messages: [] });
    expect(a.calls).toHaveLength(1);
    expect(b.calls).toHaveLength(2);
    expect((await chain.list())[0]!.cooldownUntil).toBeTruthy();

    // После паузы снова пробуем первого
    now.t += 120_000;
    await chain.chat({ messages: [] });
    expect(a.calls).toHaveLength(2);
  });

  it('любая ошибка (в т.ч. неизвестная) → следующий; ChatGPT последним', async () => {
    const a = new ScriptedProvider('openrouter', () => new Error('что-то сломалось'));
    const g = new ScriptedProvider('gemini', () => new ProviderError('gemini', 'bad_request', '400', 400));
    const c = new ScriptedProvider('chatgpt', () => ({ content: 'спасла подписка' }));
    const res = await mkChain([a, g, c]).chat({ messages: [] });
    expect(res.provider).toBe('chatgpt');
    expect(res.attempts).toHaveLength(3);
  });

  it('недоступные провайдеры пропускаются; если никого нет — понятная ошибка', async () => {
    const off = new ScriptedProvider('openrouter', () => ({ content: 'x' }), false);
    await expect(mkChain([off]).chat({ messages: [] })).rejects.toThrow(/Нет доступных провайдеров/);
    const bad = new ScriptedProvider('gemini', () => new Error('нет'));
    const err = await mkChain([bad])
      .chat({ messages: [] })
      .catch((e) => e);
    expect(err).toBeInstanceOf(AllProvidersFailedError);
    expect(err.attempts).toHaveLength(1);
  });

  it('провайдер на паузе всё же используется, если остальные упали', async () => {
    const now = { t: 0 };
    let ok = false;
    const a = new ScriptedProvider('openrouter', () =>
      ok ? { content: 'снова жив' } : new ProviderError('openrouter', 'rate_limit', '429', 429),
    );
    const b = new ScriptedProvider('gemini', () => new Error('упал'));
    const chain = mkChain([a, b], now);
    await expect(chain.chat({ messages: [] })).rejects.toBeInstanceOf(AllProvidersFailedError);
    ok = true;
    expect((await chain.chat({ messages: [] })).content).toBe('снова жив');
  });
});

describe('SSE и ответ Responses API (ChatGPT)', () => {
  const stream = (chunks: string[]) =>
    new ReadableStream<Uint8Array>({
      start(c) {
        for (const ch of chunks) c.enqueue(new TextEncoder().encode(ch));
        c.close();
      },
    });

  it('парсит события, разрезанные в произвольных местах, CRLF и комментарии', async () => {
    const raw = ': ping\r\nevent: a\r\ndata: {"n":1}\r\n\r\ndata: line1\ndata: line2\n\nevent: b\ndata: [DONE]\n\n';
    const parts = [raw.slice(0, 7), raw.slice(7, 30), raw.slice(30, 31), raw.slice(31)];
    const events = [];
    for await (const e of parseSse(stream(parts))) events.push(e);
    expect(events).toEqual([
      { event: 'a', data: '{"n":1}' },
      { event: undefined, data: 'line1\nline2' },
      { event: 'b', data: '[DONE]' },
    ]);
  });

  const sse = (events: unknown[]) => events.map((e) => `data: ${JSON.stringify(e)}\n\n`);

  it('отдаёт дельты текста в onText по мере поступления', async () => {
    const seen: string[] = [];
    const out = await collectResponse(
      parseSse(
        stream(
          sse([
            { type: 'response.output_text.delta', delta: 'При' },
            { type: 'response.output_text.delta', delta: 'вет' },
            { type: 'response.completed', response: { model: 'gpt-x', usage: { input_tokens: 1, output_tokens: 1 } } },
          ]),
        ),
      ),
      'gpt-x',
      (d) => seen.push(d),
    );
    expect(seen).toEqual(['При', 'вет']);
    expect(out.content).toBe('Привет');
  });

  it('собирает текст, вызов функции и usage', async () => {
    const out = await collectResponse(
      parseSse(
        stream(
          sse([
            { type: 'response.output_text.delta', delta: 'При' },
            {
              type: 'response.output_item.done',
              item: { type: 'message', content: [{ type: 'output_text', text: 'Привет!' }] },
            },
            {
              type: 'response.output_item.done',
              item: { type: 'function_call', call_id: 'fc1', name: 'note_create', arguments: '{"title":"x"}' },
            },
            { type: 'response.completed', response: { model: 'gpt-x', usage: { input_tokens: 11, output_tokens: 7 } } },
          ]),
        ),
      ),
      'fallback',
    );
    expect(out.content).toBe('Привет!');
    expect(out.toolCalls).toEqual([{ id: 'fc1', name: 'note_create', arguments: { title: 'x' } }]);
    expect(out.usage).toEqual({ promptTokens: 11, completionTokens: 7 });
    expect(out.model).toBe('gpt-x');
  });

  it('использует дельты, если нет итогового сообщения', async () => {
    const out = await collectResponse(
      parseSse(
        stream(
          sse([
            { type: 'response.output_text.delta', delta: 'Привет' },
            { type: 'response.output_text.delta', delta: ', мир' },
            { type: 'response.completed', response: { usage: { input_tokens: 1, output_tokens: 2 } } },
          ]),
        ),
      ),
      'm',
    );
    expect(out.content).toBe('Привет, мир');
  });

  it('ошибки модели и оборванный поток не возвращают частичный ответ', async () => {
    const failed = collectResponse(
      parseSse(
        stream(
          sse([
            { type: 'response.failed', response: { error: { code: 'model_not_found', message: 'нет такой модели' } } },
          ]),
        ),
      ),
      'm',
    );
    await expect(failed).rejects.toThrow(/model_not_found/);
    const limited = await collectResponse(
      parseSse(stream(sse([{ type: 'error', error: { code: 'usage_limit_reached', message: 'лимит' } }]))),
      'm',
    ).catch((e) => e);
    expect(limited.kind).toBe('rate_limit');
    const cut = collectResponse(
      parseSse(stream(sse([{ type: 'response.output_text.delta', delta: 'половина' }]))),
      'm',
    );
    await expect(cut).rejects.toThrow(/оборвался/);
  });
});
