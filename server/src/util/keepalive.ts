import type { Logger } from './logger.js';

/**
 * Бесплатный Render усыпляет сервис после ~15 минут без входящих запросов, а пробуждение занимает около минуты
 * (пользователь видит заставку Render). Пока сервер жив, он сам раз в несколько минут обращается к своему публичному адресу:
 * для Render это входящий запрос, и сервис не засыпает. Разбудить уже уснувший сервис может только внешний пинг
 * (workflow `keepalive.yml`), но после пробуждения сервер дальше держит себя в тонусе сам.
 */
export function startSelfPing(opts: {
  publicUrl: string | undefined;
  enabled: boolean;
  log: Logger;
  everyMs?: number;
  fetch?: typeof fetch;
}): (() => void) | null {
  const base = opts.publicUrl?.replace(/\/+$/, '');
  if (!opts.enabled || !base || !base.startsWith('https://')) return null;
  const doFetch = opts.fetch ?? fetch;
  const ping = () => {
    doFetch(`${base}/health`, { signal: AbortSignal.timeout(15_000), headers: { 'user-agent': 'polaris-self-ping' } }).catch(
      (err: unknown) => opts.log.debug({ err: String(err) }, 'Самопинг не удался'),
    );
  };
  const timer = setInterval(ping, opts.everyMs ?? 9 * 60_000);
  timer.unref();
  opts.log.info({ url: `${base}/health` }, 'Самопинг включён: сервис не уснёт, пока работает');
  return () => clearInterval(timer);
}
