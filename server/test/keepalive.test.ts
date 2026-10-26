import { describe, expect, it, vi } from 'vitest';
import { startSelfPing } from '../src/util/keepalive.js';
import { silentLogger } from '../src/util/logger.js';

describe('самопинг (бесплатный Render не должен засыпать)', () => {
  it('раз в интервал обращается к /health на публичном https-адресе и останавливается', async () => {
    const fetchMock = vi.fn(async () => new Response('{"ok":true}'));
    const stop = startSelfPing({
      publicUrl: 'https://polaris-pl.onrender.com/',
      enabled: true,
      log: silentLogger,
      everyMs: 20,
      fetch: fetchMock as unknown as typeof fetch,
    });
    expect(stop).not.toBeNull();
    await new Promise((r) => setTimeout(r, 90));
    stop!();
    const calls = fetchMock.mock.calls.length;
    expect(calls).toBeGreaterThanOrEqual(2);
    expect((fetchMock.mock.calls[0] as unknown as [string])[0]).toBe('https://polaris-pl.onrender.com/health');
    await new Promise((r) => setTimeout(r, 60));
    expect(fetchMock.mock.calls.length).toBe(calls); // после остановки больше не пингует
  });

  it('не включается без https-адреса или когда выключен; сбой сети не роняет сервер', async () => {
    const f = vi.fn(async () => {
      throw new Error('сеть недоступна');
    });
    const off = { log: silentLogger, fetch: f as unknown as typeof fetch, everyMs: 10 };
    expect(startSelfPing({ ...off, publicUrl: undefined, enabled: true })).toBeNull();
    expect(startSelfPing({ ...off, publicUrl: 'http://localhost:8787', enabled: true })).toBeNull();
    expect(startSelfPing({ ...off, publicUrl: 'https://x.onrender.com', enabled: false })).toBeNull();

    const stop = startSelfPing({ ...off, publicUrl: 'https://x.onrender.com', enabled: true })!;
    await new Promise((r) => setTimeout(r, 50));
    stop();
    expect(f).toHaveBeenCalled(); // ошибки проглатываются
  });
});
