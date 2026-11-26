import { createHash } from 'node:crypto';
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

export interface ChatGptAccount {
  /** Ключ записи в provider_credentials. */
  id: string;
  accountId?: string;
  email?: string;
  plan?: string;
  expiresAt?: string;
  /** Лимит исчерпан: до этого времени аккаунт пропускается. */
  limitedUntil?: string;
}

export interface ChatGptStatus {
  enabled: boolean;
  connected: boolean;
  /** Все подключённые аккаунты: при лимите работа продолжается на следующем. */
  accounts: ChatGptAccount[];
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

type Stored = ChatGptAccount & { tokens: TokenSet };

/**
 * Хранение и обновление OAuth-токенов подписок ChatGPT. Токены лежат в БД только в зашифрованном виде.
 * Аккаунтов может быть несколько: когда у одного кончается лимит, запрос уходит на следующий.
 */
export class ChatGptAuth {
  private readonly refreshing = new Map<string, Promise<TokenSet>>();
  /** Аккаунты с исчерпанным лимитом: ключ → время (мс), до которого их пропускаем. */
  private readonly limited = new Map<string, number>();
  /** Аккаунт, на котором последний раз всё сработало: с него начинаем следующий запрос. */
  private preferred: string | null = null;

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

  private static identity(tokens: TokenSet): string {
    const claims = extractClaims(tokens.idToken, tokens.accessToken);
    return (
      claims.email ?? claims.accountId ?? createHash('sha256').update(tokens.refreshToken).digest('hex').slice(0, 12)
    );
  }

  private decrypt(encrypted: string): TokenSet | null {
    try {
      return JSON.parse(decryptSecret(encrypted, this.ctx.config.encryptionKey)) as TokenSet;
    } catch {
      this.ctx.log.warn({ provider: PROVIDER }, 'Не удалось расшифровать токены ChatGPT (изменился ENCRYPTION_KEY?)');
      return null;
    }
  }

  private async rows(): Promise<{ provider: string; encrypted_token: string }[]> {
    const res = await this.ctx.db.query<{ provider: string; encrypted_token: string }>(
      `select provider, encrypted_token from provider_credentials
       where provider = $1 or provider like $2 order by created_at, provider`,
      [PROVIDER, `${PROVIDER}:%`],
    );
    return res;
  }

  /** Сохраняет токены. Тот же аккаунт (по почте) обновляется, новый — добавляется отдельной записью. */
  private async saveTokens(tokens: TokenSet, key?: string): Promise<string> {
    const claims = extractClaims(tokens.idToken, tokens.accessToken);
    let target = key;
    if (!target) {
      const identity = ChatGptAuth.identity(tokens);
      for (const row of await this.rows()) {
        const t = this.decrypt(row.encrypted_token);
        if (t && ChatGptAuth.identity(t) === identity) {
          target = row.provider;
          break;
        }
      }
      target ??= `${PROVIDER}:${createHash('sha256').update(identity).digest('hex').slice(0, 12)}`;
    }
    const encrypted = encryptSecret(JSON.stringify(tokens), this.ctx.config.encryptionKey);
    await this.ctx.db.query(
      `insert into provider_credentials (provider, encrypted_token, account_id, expires_at, updated_at)
       values ($1, $2, $3, $4, now())
       on conflict (provider) do update
         set encrypted_token = excluded.encrypted_token, account_id = excluded.account_id,
             expires_at = excluded.expires_at, updated_at = now()`,
      [target, encrypted, claims.accountId ?? null, new Date(tokens.expiresAt)],
    );
    return target;
  }

  private async loadTokens(key: string): Promise<TokenSet | null> {
    const row = await queryOne<{ encrypted_token: string }>(
      this.ctx.db,
      'select encrypted_token from provider_credentials where provider = $1',
      [key],
    );
    return row ? this.decrypt(row.encrypted_token) : null;
  }

  async isConnected(): Promise<boolean> {
    return (await this.accounts()).length > 0;
  }

  /** Все подключённые аккаунты в порядке подключения. */
  private async accounts(): Promise<Stored[]> {
    const out: Stored[] = [];
    for (const row of await this.rows()) {
      const tokens = this.decrypt(row.encrypted_token);
      if (!tokens) continue;
      const claims = extractClaims(tokens.idToken, tokens.accessToken);
      const until = this.limited.get(row.provider);
      out.push({
        id: row.provider,
        accountId: claims.accountId,
        email: claims.email,
        plan: claims.plan,
        expiresAt: new Date(tokens.expiresAt).toISOString(),
        limitedUntil: until && until > Date.now() ? new Date(until).toISOString() : undefined,
        tokens,
      });
    }
    return out;
  }

  /** Порядок попыток: сначала свободные (начиная с последнего рабочего), затем по очереди освобождения. */
  async order(): Promise<string[]> {
    const all = await this.accounts();
    const free = all.filter((a) => !a.limitedUntil);
    const busy = all
      .filter((a) => a.limitedUntil)
      .sort((x, y) => Date.parse(x.limitedUntil!) - Date.parse(y.limitedUntil!));
    const first = free.find((a) => a.id === this.preferred);
    return [...(first ? [first] : []), ...free.filter((a) => a !== first), ...busy].map((a) => a.id);
  }

  /** Лимит исчерпан: пропускаем аккаунт, пока он не восстановится. */
  markLimited(key: string, ms: number): void {
    this.limited.set(key, Date.now() + Math.max(30_000, ms));
    if (this.preferred === key) this.preferred = null;
  }

  markWorked(key: string): void {
    this.preferred = key;
    this.limited.delete(key);
  }

  /** Возвращает действующий access_token; при необходимости обновляет его (одним запросом на всех). */
  async getAccess(
    forceRefresh = false,
    key?: string,
  ): Promise<{ accessToken: string; accountId?: string; key: string }> {
    const useKey = key ?? (await this.order())[0];
    if (!useKey) throw new OAuthError('ChatGPT не подключён');
    let tokens = await this.loadTokens(useKey);
    if (!tokens) throw new OAuthError('ChatGPT не подключён');
    if (forceRefresh || tokens.expiresAt - Date.now() < REFRESH_SKEW_MS) {
      const stale = tokens;
      let pending = this.refreshing.get(useKey);
      if (!pending) {
        pending = refreshTokens(this.cfg, stale.refreshToken, this.ctx.fetch)
          .then(async (fresh) => {
            const merged = { ...fresh, idToken: fresh.idToken ?? stale.idToken };
            await this.saveTokens(merged, useKey);
            return merged;
          })
          .finally(() => {
            this.refreshing.delete(useKey);
          });
        this.refreshing.set(useKey, pending);
      }
      tokens = await pending;
    }
    const claims = extractClaims(tokens.idToken, tokens.accessToken);
    return { accessToken: tokens.accessToken, accountId: claims.accountId, key: useKey };
  }

  async status(): Promise<ChatGptStatus> {
    const settings = await this.ctx.settings.getChatGpt();
    const accounts: ChatGptAccount[] = (await this.accounts()).map(({ tokens: _tokens, ...account }) => account);
    const main = accounts[0];
    return {
      enabled: settings.enabled,
      connected: accounts.length > 0,
      accounts,
      accountId: main?.accountId,
      email: main?.email,
      plan: main?.plan,
      expiresAt: main?.expiresAt,
      model: settings.model,
      models: this.cfg.models,
    };
  }

  /** Без аргумента отключает все аккаунты, с аргументом — один. */
  async disconnect(key?: string): Promise<void> {
    if (key) {
      if (key !== PROVIDER && !key.startsWith(`${PROVIDER}:`)) return;
      await this.ctx.db.query('delete from provider_credentials where provider = $1', [key]);
      this.limited.delete(key);
      if (this.preferred === key) this.preferred = null;
      return;
    }
    await this.ctx.db.query('delete from provider_credentials where provider = $1 or provider like $2', [
      PROVIDER,
      `${PROVIDER}:%`,
    ]);
    this.limited.clear();
    this.preferred = null;
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
