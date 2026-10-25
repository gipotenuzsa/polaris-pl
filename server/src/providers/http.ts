import { redactString } from '../crypto/redact.js';
import { kindFromStatus, parseRetryAfter, ProviderError, type ProviderId } from './types.js';

export type FetchFn = typeof fetch;

/** Превращает не-2xx ответ в ProviderError (тело ответа обрезается и очищается от секретов). */
export async function errorFromResponse(provider: ProviderId, res: Response): Promise<ProviderError> {
  let body = '';
  try {
    body = redactString((await res.text()).slice(0, 500));
  } catch {
    /* тело недоступно */
  }
  return new ProviderError(
    provider,
    kindFromStatus(res.status),
    `${provider}: HTTP ${res.status}${body ? ` — ${body}` : ''}`,
    res.status,
    parseRetryAfter(res.headers.get('retry-after')),
  );
}

/** Обёртка над fetch: сетевые ошибки и таймауты → ProviderError. */
export async function providerFetch(
  provider: ProviderId,
  fetchFn: FetchFn,
  url: string,
  init: RequestInit,
): Promise<Response> {
  let res: Response;
  try {
    res = await fetchFn(url, init);
  } catch (err) {
    const name = (err as { name?: string }).name;
    if (name === 'TimeoutError' || name === 'AbortError') {
      throw new ProviderError(provider, 'timeout', `${provider}: таймаут запроса`);
    }
    throw new ProviderError(provider, 'network', `${provider}: сетевая ошибка (${(err as Error).message})`);
  }
  if (!res.ok) throw await errorFromResponse(provider, res);
  return res;
}

export function safeJsonParse(text: string): Record<string, unknown> {
  if (!text.trim()) return {};
  try {
    const v = JSON.parse(text) as unknown;
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : { value: v };
  } catch {
    return { __invalid_json: text.slice(0, 500) };
  }
}
