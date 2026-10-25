import type { AppContext } from '../../context.js';
import { decryptSecret, encryptSecret } from '../../crypto/secrets.js';
import { queryOne } from '../../db/types.js';
import { errorMessage } from '../../util/errors.js';
import {
  buildAuthorizeUrl,
  exchangeCode,
  extractClaims,
  generatePkce,
  generateState,
  OAuthError,
  parseCallbackInput,
  refreshTokens,
  type TokenSet,
} from './oauth.js';

const PROVIDER = 'chatgpt';
const FLOW_TTL_MS = 15 * 60_000;
const REFRESH_SKEW_MS = 5 * 60_000;

export interface ChatGptStatus {
  enabled: boolean;
  connected: boolean;
  accountId?: string;
  email?: string;
  plan?: string;
  expiresAt?: string;
  model: string;
  models: string[];
}

export interface ChatGptCheckResult {
  ok: boolean;
  model: string;
  error?: string;
  /** Модель недоступна для этого способа входа (model_not_found). */
  modelNotFound?: boolean;
  /** Модель, которая была выбрана раньше и заменена автоматически. */
  switchedFrom?: string;
  /** Модели, которые бэкенд отклонил. */
  unavailable?: string[];
}

/** Бэкенд сообщает о недоступной модели по-разному: model_not_found или «The 'x' model is not supported…». */
export function isModelError(message: string): boolean {
  return /model_not_found|model is not supported|unsupported model|unknown model|invalid model|model .{0,60}(does not exist|not available|not supported)|модель .{0,40}недоступн/i.test(
    message,
  );
}

/** Хранение и обновление OAuth-токенов подписки ChatGPT. Токены лежат в БД только в зашифрованном виде. */
export class ChatGptAuth {
  private refreshing: Promise<TokenSet> | null = null;

  constructor(private readonly ctx: AppContext) {}

  private get cfg() {
    return this.ctx.config.providers.chatgpt;
  }

  async startFlow(): Promise<{ authUrl: string; state: string; redirectUri: string }> {
    const { verifier, challenge } = generatePkce();
    const state = generateState();
    await this.ctx.db.query(`delete from oauth_flows where created_at < now() - interval '1 day'`);
    await this.ctx.db.query('insert into oauth_flows (state, provider, code_verifier) values ($1, $2, $3)', [
      state,
      PROVIDER,
      verifier,
    ]);
    return { authUrl: buildAuthorizeUrl(this.cfg, state, challenge), state, redirectUri: this.cfg.redirectUri };
  }

  /** Принимает адрес, который пользователь скопировал из браузера после входа. */
  async completeFlow(pastedUrl: string): Promise<ChatGptStatus> {
    const { code, state } = parseCallbackInput(pastedUrl);
    const flow = state
      ? await queryOne<{ state: string; code_verifier: string; created_at: Date }>(
          this.ctx.db,
          'select state, code_verifier, created_at from oauth_flows where state = $1 and provider = $2',
          [state, PROVIDER],
        )
      : await queryOne<{ state: string; code_verifier: string; created_at: Date }>(
          this.ctx.db,
          'select state, code_verifier, created_at from oauth_flows where provider = $1 order by created_at desc limit 1',
          [PROVIDER],
        );
    if (!flow) throw new OAuthError('Сессия входа не найдена или устарела. Нажмите «Подключить ChatGPT» ещё раз.');
    if (Date.now() - new Date(flow.created_at).getTime() > FLOW_TTL_MS) {
      await this.ctx.db.query('delete from oauth_flows where state = $1', [flow.state]);
      throw new OAuthError('Сессия входа истекла (15 минут). Нажмите «Подключить ChatGPT» ещё раз.');
    }
    const tokens = await exchangeCode(this.cfg, code, flow.code_verifier, this.ctx.fetch);
    await this.ctx.db.query('delete from oauth_flows where state = $1', [flow.state]);
    await this.saveTokens(tokens);
    return this.status();
  }

  private async saveTokens(tokens: TokenSet): Promise<void> {
    const claims = extractClaims(tokens.idToken, tokens.accessToken);
    const encrypted = encryptSecret(JSON.stringify(tokens), this.ctx.config.encryptionKey);
    await this.ctx.db.query(
      `insert into provider_credentials (provider, encrypted_token, account_id, expires_at, updated_at)
       values ($1, $2, $3, $4, now())
       on conflict (provider) do update
         set encrypted_token = excluded.encrypted_token, account_id = excluded.account_id,
             expires_at = excluded.expires_at, updated_at = now()`,
      [PROVIDER, encrypted, claims.accountId ?? null, new Date(tokens.expiresAt)],
    );
  }

  private async loadTokens(): Promise<TokenSet | null> {
    const row = await queryOne<{ encrypted_token: string }>(
      this.ctx.db,
      'select encrypted_token from provider_credentials where provider = $1',
      [PROVIDER],
    );
    if (!row) return null;
    try {
      return JSON.parse(decryptSecret(row.encrypted_token, this.ctx.config.encryptionKey)) as TokenSet;
    } catch {
      this.ctx.log.warn({ provider: PROVIDER }, 'Не удалось расшифровать токены ChatGPT (изменился ENCRYPTION_KEY?)');
      return null;
    }
  }

  async isConnected(): Promise<boolean> {
    return (await this.loadTokens()) !== null;
  }

  /** Возвращает действующий access_token; при необходимости обновляет его (одним запросом на всех). */
  async getAccess(forceRefresh = false): Promise<{ accessToken: string; accountId?: string }> {
    let tokens = await this.loadTokens();
    if (!tokens) throw new OAuthError('ChatGPT не подключён');
    if (forceRefresh || tokens.expiresAt - Date.now() < REFRESH_SKEW_MS) {
      const stale = tokens;
      this.refreshing ??= refreshTokens(this.cfg, stale.refreshToken, this.ctx.fetch)
        .then(async (fresh) => {
          const merged = { ...fresh, idToken: fresh.idToken ?? stale.idToken };
          await this.saveTokens(merged);
          return merged;
        })
        .finally(() => {
          this.refreshing = null;
        });
      tokens = await this.refreshing;
    }
    const claims = extractClaims(tokens.idToken, tokens.accessToken);
    return { accessToken: tokens.accessToken, accountId: claims.accountId };
  }

  async status(): Promise<ChatGptStatus> {
    const settings = await this.ctx.settings.getChatGpt();
    const tokens = await this.loadTokens();
    const claims = tokens ? extractClaims(tokens.idToken, tokens.accessToken) : {};
    return {
      enabled: settings.enabled,
      connected: tokens !== null,
      accountId: claims.accountId,
      email: claims.email,
      plan: claims.plan,
      expiresAt: tokens ? new Date(tokens.expiresAt).toISOString() : undefined,
      model: settings.model,
      models: this.cfg.models,
    };
  }

  async disconnect(): Promise<void> {
    await this.ctx.db.query('delete from provider_credentials where provider = $1', [PROVIDER]);
    await this.ctx.db.query('delete from oauth_flows where provider = $1', [PROVIDER]);
  }

  /**
   * «Проверить вход»: реальный минимальный запрос к API, а не проверка наличия токена.
   * Если выбранная модель недоступна для этого способа входа, а ChatGPT — единственный провайдер,
   * по умолчанию подбирается первая рабочая модель из списка и сохраняется в настройках.
   */
  async check(opts: { autoSelect?: boolean } = {}): Promise<ChatGptCheckResult> {
    const autoSelect = opts.autoSelect ?? true;
    const settings = await this.ctx.settings.getChatGpt();
    if (!(await this.isConnected())) return { ok: false, model: settings.model, error: 'ChatGPT не подключён' };

    const { ChatGptProvider } = await import('./provider.js');
    const probe = (model: string) =>
      new ChatGptProvider(this.ctx, { model }).chat({
        messages: [{ role: 'user', content: 'Reply with the single word: ok' }],
        signal: AbortSignal.timeout(45_000),
      });

    const candidates = [settings.model, ...this.cfg.models.filter((m) => m !== settings.model)];
    const unavailable: string[] = [];
    for (const model of candidates) {
      try {
        await probe(model);
        if (model === settings.model) return { ok: true, model };
        await this.setModel(model);
        return { ok: true, model, switchedFrom: settings.model, unavailable };
      } catch (err) {
        const msg = errorMessage(err);
        if (!isModelError(msg)) return { ok: false, model, error: msg };
        unavailable.push(model);
        if (!autoSelect) return { ok: false, model, error: msg, modelNotFound: true, unavailable };
      }
    }
    return {
      ok: false,
      model: settings.model,
      modelNotFound: true,
      unavailable,
      error: `Ни одна из моделей (${unavailable.join(', ')}) недоступна для этого способа входа. Укажите другую модель вручную.`,
    };
  }

  async setModel(model: string): Promise<void> {
    const cur = await this.ctx.settings.getChatGpt();
    await this.ctx.settings.set('chatgpt', { ...cur, model });
  }

  async setEnabled(enabled: boolean): Promise<void> {
    const cur = await this.ctx.settings.getChatGpt();
    await this.ctx.settings.set('chatgpt', { ...cur, enabled });
  }
}
