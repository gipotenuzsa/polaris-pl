import dns from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { Readable } from 'node:stream';
import zlib from 'node:zlib';

export class UrlBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UrlBlockedError';
  }
}

function ipv4ToInt(ip: string): number {
  return ip.split('.').reduce((acc, p) => (acc << 8) + Number(p), 0) >>> 0;
}

const V4_PRIVATE: [string, number][] = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
];

export function isPrivateIp(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const n = ipv4ToInt(ip);
    return V4_PRIVATE.some(([base, bits]) => {
      const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
      return (n & mask) === (ipv4ToInt(base) & mask);
    });
  }
  if (net.isIPv6(ip)) {
    const lower = ip.toLowerCase();
    if (lower === '::' || lower === '::1') return true;
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
    if (mapped) return isPrivateIp(mapped[1]!);
    const mappedHex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(lower);
    if (mappedHex) {
      const hi = parseInt(mappedHex[1]!, 16);
      const lo = parseInt(mappedHex[2]!, 16);
      return isPrivateIp(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
    }
    const first = parseInt(lower.split(':')[0] || '0', 16);
    if ((first & 0xfe00) === 0xfc00) return true; // fc00::/7
    if ((first & 0xffc0) === 0xfe80) return true; // fe80::/10
    if ((first & 0xff00) === 0xff00) return true; // multicast
    return false;
  }
  return true; // не IP — на всякий случай считаем недопустимым
}

export interface UrlPolicy {
  allowPrivate: boolean;
}

/** Предварительная проверка адреса (схема, учётные данные, IP-литералы, DNS). */
export async function assertPublicUrl(raw: string, policy: UrlPolicy): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new UrlBlockedError(`Некорректный URL: ${raw}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new UrlBlockedError('Разрешены только http и https');
  if (url.username || url.password) throw new UrlBlockedError('URL с логином и паролем не поддерживается');
  if (policy.allowPrivate) return url;

  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal') || host.endsWith('.local')) {
    throw new UrlBlockedError('Доступ к локальным адресам запрещён');
  }
  if (net.isIP(host)) {
    if (isPrivateIp(host)) throw new UrlBlockedError('Доступ к внутренним адресам запрещён');
    return url;
  }
  const addrs = await dns.lookup(host, { all: true }).catch(() => {
    throw new UrlBlockedError(`Не удалось определить адрес ${host}`);
  });
  if (addrs.length === 0 || addrs.some((a) => isPrivateIp(a.address))) {
    throw new UrlBlockedError('Адрес указывает на внутреннюю сеть — доступ запрещён');
  }
  return url;
}

export interface SafeFetchOptions extends UrlPolicy {
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
  headers?: Record<string, string>;
  signal?: AbortSignal;
}

export interface SafeFetchResult {
  url: string;
  status: number;
  contentType: string;
  body: Buffer;
  truncated: boolean;
}

type LookupCb = (err: Error | null, address: string | { address: string; family: number }[], family?: number) => void;

function makeLookup(policy: UrlPolicy) {
  return (hostname: string, options: { all?: boolean; family?: number }, cb: LookupCb) => {
    dns
      .lookup(hostname, { ...options, all: true })
      .then((addrs) => {
        if (!policy.allowPrivate && addrs.some((a) => isPrivateIp(a.address))) {
          cb(new UrlBlockedError('Адрес указывает на внутреннюю сеть — доступ запрещён'), '');
          return;
        }
        if (options.all) cb(null, addrs);
        else cb(null, addrs[0]!.address, addrs[0]!.family);
      })
      .catch((err: Error) => cb(err, ''));
  };
}

function requestOnce(url: URL, opts: SafeFetchOptions): Promise<{ res: http.IncomingMessage; stream: Readable }> {
  return new Promise((resolve, reject) => {
    const mod = url.protocol === 'https:' ? https : http;
    const req = mod.request(
      url,
      {
        method: 'GET',
        headers: {
          'user-agent': 'Mozilla/5.0 (compatible; PolarisBot/0.1; +https://github.com/polaris-pl)',
          accept: 'text/html,application/xhtml+xml,application/json,text/plain;q=0.9,*/*;q=0.5',
          'accept-encoding': 'gzip, deflate, br',
          ...opts.headers,
        },
        // Адрес проверяется в момент соединения — защита от DNS rebinding.
        lookup: makeLookup(opts) as unknown as net.LookupFunction,
        signal: opts.signal,
        timeout: opts.timeoutMs ?? 15_000,
      },
      (res) => {
        const enc = String(res.headers['content-encoding'] ?? '').toLowerCase();
        let stream: Readable = res;
        if (enc === 'gzip' || enc === 'x-gzip') stream = res.pipe(zlib.createGunzip());
        else if (enc === 'deflate') stream = res.pipe(zlib.createInflate());
        else if (enc === 'br') stream = res.pipe(zlib.createBrotliDecompress());
        resolve({ res, stream });
      },
    );
    req.on('timeout', () => req.destroy(new Error('Таймаут запроса')));
    req.on('error', reject);
    req.end();
  });
}

async function readLimited(stream: Readable, maxBytes: number): Promise<{ body: Buffer; truncated: boolean }> {
  const chunks: Buffer[] = [];
  let size = 0;
  let truncated = false;
  for await (const chunk of stream) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    if (size + buf.length > maxBytes) {
      chunks.push(buf.subarray(0, maxBytes - size));
      truncated = true;
      stream.destroy();
      break;
    }
    chunks.push(buf);
    size += buf.length;
  }
  return { body: Buffer.concat(chunks), truncated };
}

/** GET с защитой от SSRF: проверка каждого редиректа, ограничение размера и времени. */
export async function safeFetch(rawUrl: string, opts: SafeFetchOptions): Promise<SafeFetchResult> {
  const maxRedirects = opts.maxRedirects ?? 5;
  const maxBytes = opts.maxBytes ?? 2_000_000;
  let current = await assertPublicUrl(rawUrl, opts);

  for (let i = 0; i <= maxRedirects; i++) {
    const { res, stream } = await requestOnce(current, opts);
    const status = res.statusCode ?? 0;
    const location = res.headers.location;
    if (status >= 300 && status < 400 && location) {
      res.resume();
      current = await assertPublicUrl(new URL(location, current).toString(), opts);
      continue;
    }
    const { body, truncated } = await readLimited(stream, maxBytes);
    return {
      url: current.toString(),
      status,
      contentType: String(res.headers['content-type'] ?? ''),
      body,
      truncated,
    };
  }
  throw new UrlBlockedError('Слишком много перенаправлений');
}
