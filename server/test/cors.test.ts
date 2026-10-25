import { afterEach, describe, expect, it } from 'vitest';
import { createTestEnv, login, type TestEnv } from './helpers.js';

let env: TestEnv;
afterEach(async () => {
  await env?.close();
  env = undefined as unknown as TestEnv;
});

describe('CORS для веб-клиента в режиме разработки', () => {
  it('разрешает только перечисленные origin; preflight отвечает без авторизации', async () => {
    env = await createTestEnv({ config: { CORS_ORIGINS: 'http://localhost:8081/' } });

    const pre = await env.app.inject({
      method: 'OPTIONS',
      url: '/api/conversations',
      headers: { origin: 'http://localhost:8081', 'access-control-request-method': 'POST' },
    });
    expect(pre.statusCode).toBe(204);
    expect(pre.headers['access-control-allow-origin']).toBe('http://localhost:8081');
    expect(String(pre.headers['access-control-allow-headers'])).toContain('authorization');

    const h = await login(env.app);
    const ok = await env.app.inject({ url: '/api/conversations', headers: { ...h, origin: 'http://localhost:8081' } });
    expect(ok.statusCode).toBe(200);
    expect(ok.headers['access-control-allow-origin']).toBe('http://localhost:8081');

    const evil = await env.app.inject({ url: '/api/conversations', headers: { ...h, origin: 'https://evil.example' } });
    expect(evil.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('по умолчанию CORS выключен', async () => {
    env = await createTestEnv();
    const res = await env.app.inject({
      method: 'OPTIONS',
      url: '/api/conversations',
      headers: { origin: 'http://localhost:8081' },
    });
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });
});
