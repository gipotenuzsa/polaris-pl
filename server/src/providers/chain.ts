import { errorMessage } from '../util/errors.js';
import type { Logger } from '../util/logger.js';
import {
  ProviderError,
  type ChatRequest,
  type ChatResponse,
  type ModelProvider,
  type ProviderErrorKind,
  type ProviderId,
} from './types.js';

export interface Attempt {
  provider: ProviderId;
  ok: boolean;
  kind?: ProviderErrorKind;
  error?: string;
  ms: number;
}

export class AllProvidersFailedError extends Error {
  constructor(public readonly attempts: Attempt[]) {
    super(
      attempts.length
        ? `Ни один провайдер не ответил: ${attempts.map((a) => `${a.provider} — ${a.error}`).join('; ')}`
        : 'Нет доступных провайдеров моделей. Подключите ChatGPT: Ещё → Настройки → ChatGPT (OAuth).',
    );
    this.name = 'AllProvidersFailedError';
  }
}

export interface ProviderStatus {
  id: ProviderId;
  label: string;
  model: string;
  available: boolean;
  /** Пауза после 429/сбоя, ISO */
  cooldownUntil?: string;
}

export interface ChainResult extends ChatResponse {
  attempts: Attempt[];
}

const DEFAULT_COOLDOWN_MS = 30_000;
const MAX_COOLDOWN_MS = 10 * 60_000;

/**
 * Цепочка провайдеров с фолбэком. Порядок задан при создании (ChatGPT OAuth всегда последний).
 * При 429, таймауте или любой ошибке запрос уходит к следующему провайдеру целиком —
 * провайдеры вызываются без стриминга, поэтому частичных ответов не бывает.
 */
export class ProviderChain {
  private readonly cooldown = new Map<ProviderId, number>();

  constructor(
    private readonly providers: ModelProvider[],
    private readonly opts: { timeoutMs: number; log: Logger; now?: () => number },
  ) {}

  private now(): number {
    return this.opts.now?.() ?? Date.now();
  }

  async list(): Promise<ProviderStatus[]> {
    return Promise.all(
      this.providers.map(async (p) => {
        const until = this.cooldown.get(p.id);
        return {
          id: p.id,
          label: p.label,
          model: await p.currentModel(),
          available: await p.isAvailable(),
          cooldownUntil: until && until > this.now() ? new Date(until).toISOString() : undefined,
        };
      }),
    );
  }

  async chat(req: ChatRequest): Promise<ChainResult> {
    const attempts: Attempt[] = [];
    const candidates: ModelProvider[] = [];
    for (const p of this.providers) if (await p.isAvailable()) candidates.push(p);

    // Провайдеры на паузе пробуем в самом конце: лучше медленно ответить, чем не ответить.
    const ready = candidates.filter((p) => (this.cooldown.get(p.id) ?? 0) <= this.now());
    const paused = candidates.filter((p) => !ready.includes(p));

    for (const provider of [...ready, ...paused]) {
      if (req.signal?.aborted) throw new Error('Запрос отменён');
      const started = this.now();
      try {
        const signal = req.signal
          ? AbortSignal.any([req.signal, AbortSignal.timeout(this.opts.timeoutMs)])
          : AbortSignal.timeout(this.opts.timeoutMs);
        const res = await provider.chat({ ...req, signal });
        this.cooldown.delete(provider.id);
        attempts.push({ provider: provider.id, ok: true, ms: this.now() - started });
        return { ...res, attempts };
      } catch (err) {
        const kind: ProviderErrorKind = err instanceof ProviderError ? err.kind : 'network';
        const message = errorMessage(err);
        attempts.push({ provider: provider.id, ok: false, kind, error: message, ms: this.now() - started });
        this.opts.log.warn({ provider: provider.id, kind }, `Провайдер недоступен, пробуем следующий: ${message}`);
        if (kind === 'rate_limit' || kind === 'server' || kind === 'timeout' || kind === 'network') {
          const retry = err instanceof ProviderError ? err.retryAfterMs : undefined;
          this.cooldown.set(provider.id, this.now() + Math.min(retry ?? DEFAULT_COOLDOWN_MS, MAX_COOLDOWN_MS));
        }
      }
    }
    throw new AllProvidersFailedError(attempts);
  }
}
