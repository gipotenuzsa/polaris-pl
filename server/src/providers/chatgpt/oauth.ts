import { createHash, randomBytes } from 'node:crypto';
import type { Config } from '../../config.js';
import type { FetchFn } from '../http.js';

export type ChatGptConfig = Config['providers']['chatgpt'];

export interface TokenSet {
  accessToken: string;
  refreshToken: string;
  idToken?: string;
  /** Unix ms */
  expiresAt: number;
}

export class OAuthError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = 'OAuthError';
  }
}

export function generatePkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(64).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

export function generateState(): string {
  return randomBytes(32).toString('base64url');
}

export function buildAuthorizeUrl(cfg: ChatGptConfig, state: string, challenge: string): string {
  const url = new URL(`${cfg.issuer}/oauth/authorize`);
  const q = url.searchParams;
  q.set('response_type', 'code');
  q.set('client_id', cfg.clientId);
  q.set('redirect_uri', cfg.redirectUri);
  q.set('scope', cfg.scope);
  q.set('code_challenge', challenge);
  q.set('code_challenge_method', 'S256');
  q.set('id_token_add_organizations', 'true');
  q.set('codex_cli_simplified_flow', 'true');
  q.set('state', state);
  q.set('originator', cfg.originator);
  return url.toString();
}

/**
 * Пользователь вставляет адрес из строки браузера после входа
 * (http://localhost:1455/auth/callback?code=...&state=...). Страница при этом не открывается — это нормально.
 * Принимаем также голую query-строку.
 */
export function parseCallbackInput(input: string): { code: string; state?: string } {
  const text = input.trim();
  if (!text) throw new OAuthError('Вставьте адрес из строки браузера после входа');
  let params: URLSearchParams;
  try {
    params = new URL(text).searchParams;
  } catch {
    params = new URLSearchParams(text.replace(/^\?/, ''));
  }
  const err = params.get('error');
  if (err)
    throw new OAuthError(
      `OpenAI вернул ошибку: ${err}${params.get('error_description') ? ` — ${params.get('error_description')}` : ''}`,
    );
  const code = params.get('code');
  if (!code) throw new OAuthError('В адресе нет параметра code. Скопируйте адрес целиком, вместе с «?code=…».');
  return { code, state: params.get('state') ?? undefined };
}

export function decodeJwt(token: string): Record<string, unknown> | null {
  const parts = token.split('.');
  if (parts.length < 2 || !parts[1]) return null;
  try {
    return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export interface IdentityClaims {
  accountId?: string;
  email?: string;
  plan?: string;
  exp?: number;
}

export function extractClaims(...tokens: (string | undefined)[]): IdentityClaims {
  const out: IdentityClaims = {};
  for (const t of tokens) {
    if (!t) continue;
    const payload = decodeJwt(t);
    if (!payload) continue;
    const auth = payload['https://api.openai.com/auth'] as Record<string, unknown> | undefined;
    out.accountId ??= (auth?.chatgpt_account_id as string | undefined) ?? undefined;
    out.plan ??= (auth?.chatgpt_plan_type as string | undefined) ?? undefined;
    out.email ??= (payload.email as string | undefined) ?? undefined;
    out.exp ??= typeof payload.exp === 'number' ? payload.exp : undefined;
  }
  return out;
}

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  id_token?: string;
  expires_in?: number;
  error?: string | { message?: string; code?: string };
  error_description?: string;
}

function toTokenSet(data: TokenResponse, previousRefresh?: string): TokenSet {
  if (!data.access_token) throw new OAuthError('Ответ OpenAI не содержит access_token');
  const refreshToken = data.refresh_token ?? previousRefresh;
  if (!refreshToken) throw new OAuthError('Ответ OpenAI не содержит refresh_token (нужен scope offline_access)');
  const claims = extractClaims(data.access_token);
  const expiresAt = claims.exp
    ? claims.exp * 1000
    : Date.now() + (typeof data.expires_in === 'number' ? data.expires_in : 3600) * 1000;
  return { accessToken: data.access_token, refreshToken, idToken: data.id_token, expiresAt };
}

async function readTokenResponse(res: Response): Promise<TokenResponse> {
  const text = await res.text();
  let data: TokenResponse = {};
  try {
    data = JSON.parse(text) as TokenResponse;
  } catch {
    /* не JSON */
  }
  if (!res.ok) {
    const e = data.error;
    const detail =
      typeof e === 'string'
        ? `${e}${data.error_description ? `: ${data.error_description}` : ''}`
        : (e?.message ?? e?.code ?? '');
    throw new OAuthError(`Обмен токена не удался (HTTP ${res.status})${detail ? `: ${detail}` : ''}`, res.status);
  }
  return data;
}

export async function exchangeCode(
  cfg: ChatGptConfig,
  code: string,
  verifier: string,
  fetchFn: FetchFn = fetch,
): Promise<TokenSet> {
  const res = await fetchFn(`${cfg.issuer}/oauth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: cfg.redirectUri,
      client_id: cfg.clientId,
      code_verifier: verifier,
    }),
    signal: AbortSignal.timeout(20_000),
  });
  return toTokenSet(await readTokenResponse(res));
}

export async function refreshTokens(
  cfg: ChatGptConfig,
  refreshToken: string,
  fetchFn: FetchFn = fetch,
): Promise<TokenSet> {
  const res = await fetchFn(`${cfg.issuer}/oauth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      client_id: cfg.clientId,
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      scope: 'openid profile email',
    }),
    signal: AbortSignal.timeout(20_000),
  });
  return toTokenSet(await readTokenResponse(res), refreshToken);
}
