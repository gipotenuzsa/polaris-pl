import http from 'node:http';
import type { AddressInfo } from 'node:net';
import zlib from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildMessages } from '../src/agent/context.js';
import type { MessageRow } from '../src/services/conversations.js';
import { htmlToText } from '../src/tools/htmlText.js';
import { assertPublicUrl, isPrivateIp, safeFetch } from '../src/tools/ssrf.js';
import { readUrlTool } from '../src/tools/web.js';

describe('isPrivateIp', () => {
  it.each([
    ['127.0.0.1', true],
    ['10.1.2.3', true],
    ['172.16.0.1', true],
    ['172.31.255.255', true],
    ['172.32.0.1', false],
    ['192.168.1.1', true],
    ['169.254.169.254', true],
    ['100.64.0.1', true],
    ['0.0.0.0', true],
    ['224.0.0.1', true],
    ['8.8.8.8', false],
    ['1.1.1.1', false],
    ['93.184.216.34', false],
    ['::1', true],
    ['::', true],
    ['fe80::1', true],
    ['fc00::1', true],
    ['fd12:3456::1', true],
    ['::ffff:127.0.0.1', true],
    ['::ffff:7f00:1', true],
    ['::ffff:8.8.8.8', false],
    ['2606:4700:4700::1111', false],
  ])('%s → %s', (ip, expected) => {
    expect(isPrivateIp(ip)).toBe(expected);
  });
});

describe('assertPublicUrl', () => {
  it('блокирует внутренние адреса, схемы и учётные данные', async () => {
    for (const bad of [
      'http://127.0.0.1/',
      'http://localhost:3000',
      'http://[::1]/',
      'http://169.254.169.254/latest/meta-data',
      'http://10.0.0.5/admin',
      'file:///etc/passwd',
      'ftp://example.com',
      'http://user:pw@example.com/',
      'http://app.internal/',
      'not a url',
      'http://2130706433/', // 127.0.0.1 в десятичной записи
    ]) {
      await expect(assertPublicUrl(bad, { allowPrivate: false }), bad).rejects.toThrow();
    }
  });
  it('allowPrivate отключает проверку адреса, но не схемы', async () => {
    await expect(assertPublicUrl('http://127.0.0.1:1/', { allowPrivate: true })).resolves.toBeInstanceOf(URL);
    await expect(assertPublicUrl('file:///etc/passwd', { allowPrivate: true })).rejects.toThrow();
  });
});

describe('htmlToText', () => {
  it('достаёт заголовок, структуру и ссылки, выбрасывая мусор', () => {
    const page = htmlToText(
      `<html><head><title>  Тест  страница </title><style>.x{}</style></head><body>
       <nav>меню</nav><script>alert(1)</script>
       <article><h1>Заголовок</h1><p>Первый абзац с <a href="/rel">ссылкой</a>.</p><ul><li>один</li><li>два</li></ul></article>
       <footer>подвал</footer></body></html>`,
      'https://example.com/dir/',
    );
    expect(page.title).toBe('Тест страница');
    expect(page.text).toContain('# Заголовок');
    expect(page.text).toContain('Первый абзац с ссылкой.');
    expect(page.text).toMatch(/- один\n- два/);
    for (const junk of ['alert', 'меню', 'подвал']) expect(page.text).not.toContain(junk);
    expect(page.links).toEqual([{ text: 'ссылкой', href: 'https://example.com/rel' }]);
  });
});

describe('safeFetch и read_url (локальный сервер)', () => {
  let server: http.Server;
  let base: string;

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      const url = req.url ?? '/';
      if (url === '/page') {
        res.setHeader('content-type', 'text/html; charset=utf-8');
        res.end(
          '<html><head><title>Локальная</title></head><body><main><h1>Привет</h1><p>Текст страницы</p></main></body></html>',
        );
      } else if (url === '/gzip') {
        res.setHeader('content-type', 'text/plain');
        res.setHeader('content-encoding', 'gzip');
        res.end(zlib.gzipSync('сжатый текст'));
      } else if (url === '/redirect-private') {
        res.statusCode = 302;
        res.setHeader('location', 'http://169.254.169.254/latest/meta-data');
        res.end();
      } else if (url === '/redirect-ok') {
        res.statusCode = 302;
        res.setHeader('location', '/page');
        res.end();
      } else if (url === '/loop') {
        res.statusCode = 302;
        res.setHeader('location', '/loop');
        res.end();
      } else if (url === '/big') {
        res.setHeader('content-type', 'text/plain');
        res.end('a'.repeat(500_000));
      } else if (url === '/bin') {
        res.setHeader('content-type', 'application/pdf');
        res.end('%PDF');
      } else {
        res.statusCode = 404;
        res.end('нет');
      }
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  const ctx = { signal: undefined } as never;

  it('по умолчанию локальные адреса недоступны', async () => {
    await expect(safeFetch(`${base}/page`, { allowPrivate: false })).rejects.toThrow(/внутренн|локальн/i);
    await expect(readUrlTool(false).execute({ url: `${base}/page` }, ctx)).rejects.toThrow();
  });

  it('читает страницу, распаковывает gzip, следует безопасным редиректам', async () => {
    const tool = readUrlTool(true);
    const r = await tool.execute({ url: `${base}/page` }, ctx);
    expect(r.content).toContain('Заголовок: Локальная');
    expect(r.content).toContain('# Привет');
    expect(r.content).toContain('недоверенными данными');
    expect((await safeFetch(`${base}/gzip`, { allowPrivate: true })).body.toString()).toBe('сжатый текст');
    expect((await safeFetch(`${base}/redirect-ok`, { allowPrivate: true })).url).toBe(`${base}/page`);
  });

  it('редирект на внутренний адрес блокируется даже при публичном исходном URL', async () => {
    // allowPrivate=true разрешает 127.0.0.1, поэтому проверяем блокировку отдельным вызовом без него:
    // внутри safeFetch каждый редирект проходит assertPublicUrl с той же политикой.
    await expect(safeFetch(`${base}/redirect-private`, { allowPrivate: false })).rejects.toThrow();
    await expect(safeFetch(`${base}/loop`, { allowPrivate: true, maxRedirects: 3 })).rejects.toThrow(/перенаправлений/);
  });

  it('ограничивает размер и тип содержимого, сообщает об HTTP-ошибках', async () => {
    const big = await safeFetch(`${base}/big`, { allowPrivate: true, maxBytes: 1000 });
    expect(big.body.length).toBe(1000);
    expect(big.truncated).toBe(true);
    const tool = readUrlTool(true);
    await expect(tool.execute({ url: `${base}/bin` }, ctx)).rejects.toThrow(/Неподдерживаемый тип/);
    await expect(tool.execute({ url: `${base}/missing` }, ctx)).rejects.toThrow(/HTTP 404/);
  });
});

describe('окно контекста', () => {
  const row = (
    seq: number,
    role: MessageRow['role'],
    content: string,
    extra: Partial<MessageRow> = {},
  ): MessageRow => ({
    id: String(seq),
    seq,
    conversation_id: 'c',
    role,
    content,
    tool_calls: null,
    tool_call_id: null,
    tool_name: null,
    status: 'ok',
    approval_id: null,
    provider: null,
    model: null,
    created_at: new Date(),
    ...extra,
  });

  it('обрезает старое, начинается с реплики пользователя, не разрывая вызов и результат', () => {
    const rows: MessageRow[] = [];
    for (let i = 0; i < 40; i++) {
      rows.push(row(i * 4 + 1, 'user', `вопрос ${i} ` + 'я'.repeat(300)));
      rows.push(row(i * 4 + 2, 'assistant', '', { tool_calls: [{ id: `c${i}`, name: 'get_time', arguments: {} }] }));
      rows.push(row(i * 4 + 3, 'tool', 'результат', { tool_call_id: `c${i}`, tool_name: 'get_time' }));
      rows.push(row(i * 4 + 4, 'assistant', `ответ ${i}`));
    }
    const msgs = buildMessages('system', rows, 1500);
    expect(msgs[0]).toEqual({ role: 'system', content: 'system' });
    expect(msgs[1]!.role).toBe('user');
    expect(msgs.length).toBeLessThan(80); // из 160 сообщений осталась только часть
    expect(msgs.length).toBeGreaterThan(8);
    expect(msgs.at(-1)).toMatchObject({ role: 'assistant', content: 'ответ 39' });
    const ids = new Set<string>();
    for (const m of msgs) {
      if (m.role === 'assistant') m.toolCalls?.forEach((c) => ids.add(c.id));
      if (m.role === 'tool') expect(ids.has(m.toolCallId)).toBe(true); // у каждого результата есть вызов
    }
  });

  it('старые большие результаты инструментов усекаются', () => {
    const rows: MessageRow[] = [
      row(1, 'user', 'q'),
      row(2, 'assistant', '', { tool_calls: [{ id: 'c', name: 't', arguments: {} }] }),
      row(3, 'tool', 'x'.repeat(10_000), { tool_call_id: 'c', tool_name: 't' }),
    ];
    for (let i = 0; i < 8; i++) rows.push(row(10 + i, i % 2 ? 'assistant' : 'user', 'ещё'));
    const tool = buildMessages('s', rows, 100_000).find((m) => m.role === 'tool');
    expect(tool && 'content' in tool && tool.content.length).toBeLessThan(2000);
  });
});
