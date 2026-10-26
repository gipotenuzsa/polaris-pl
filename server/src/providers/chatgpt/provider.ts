import { randomUUID } from 'node:crypto';
import type { AppContext } from '../../context.js';
import { providerFetch } from '../http.js';
import { ProviderError, type ChatRequest, type ChatResponse, type ModelProvider } from '../types.js';
import { buildResponsesBody, readResponsesBody } from './responses.js';

/**
 * ChatGPT по OAuth-подписке (бэкенд Codex). Личное использование на своей подписке.
 * Неофициальный интерфейс: может измениться без предупреждения — поэтому провайдер всегда последний в цепочке.
 */
export class ChatGptProvider implements ModelProvider {
  readonly id = 'chatgpt' as const;
  readonly label = 'ChatGPT (OAuth)';
  private readonly sessionId = randomUUID();
  /** Бэкенд отверг инструмент web_search — дальше работаем без него, чтобы не ломать ответы. */
  private searchRejected = false;

  /** opts.model — разовая подмена модели (проверка доступности), без изменения настроек. */
  constructor(
    private readonly ctx: AppContext,
    private readonly opts: { model?: string } = {},
  ) {}

  async currentModel(): Promise<string> {
    return this.opts.model ?? (await this.ctx.settings.getChatGpt()).model;
  }

  async isAvailable(): Promise<boolean> {
    const settings = await this.ctx.settings.getChatGpt();
    return settings.enabled && (await this.ctx.chatgpt.isConnected());
  }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    const cfg = this.ctx.config.providers.chatgpt;
    const model = await this.currentModel();
    const bodyFor = (search: boolean) => JSON.stringify(buildResponsesBody(model, req.messages, req.tools, search));
    let search = cfg.webSearch && !this.searchRejected;

    const send = async (forceRefresh: boolean) => {
      const { accessToken, accountId } = await this.ctx.chatgpt.getAccess(forceRefresh).catch((err: unknown) => {
        throw new ProviderError('chatgpt', 'auth', `chatgpt: ${(err as Error).message}`, 401);
      });
      const headers: Record<string, string> = {
        authorization: `Bearer ${accessToken}`,
        'content-type': 'application/json',
        accept: 'text/event-stream',
        'openai-beta': 'responses=experimental',
        originator: cfg.originator,
        session_id: this.sessionId,
        'user-agent': 'polaris-pl',
      };
      if (accountId) headers['chatgpt-account-id'] = accountId;
      return providerFetch('chatgpt', this.ctx.fetch, `${cfg.backendUrl}/responses`, {
        method: 'POST',
        headers,
        body: bodyFor(search),
        signal: req.signal,
      });
    };

    let res: Response;
    try {
      res = await send(false);
    } catch (err) {
      if (err instanceof ProviderError && err.status === 401) res = await send(true);
      else if (search && err instanceof ProviderError && err.kind === 'bad_request' && /web[_ ]?search|tool/i.test(err.message)) {
        // Возможно, бэкенд не принимает web_search: пробуем тот же запрос без него и запоминаем это.
        this.ctx.log.warn({ err: err.message }, 'ChatGPT отверг запрос с web_search, повторяю без встроенного поиска');
        search = false;
        res = await send(false);
        this.searchRejected = true;
      } else throw err;
    }

    try {
      const out = await readResponsesBody(res, model, req.onText);
      return { ...out, provider: 'chatgpt' };
    } catch (err) {
      if (err instanceof ProviderError) throw err;
      const name = (err as { name?: string }).name;
      if (name === 'TimeoutError' || name === 'AbortError') {
        throw new ProviderError('chatgpt', 'timeout', 'chatgpt: таймаут при чтении ответа');
      }
      throw new ProviderError('chatgpt', 'network', `chatgpt: ошибка чтения потока (${(err as Error).message})`);
    }
  }
}
