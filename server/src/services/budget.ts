import type { AppContext } from '../context.js';
import type { Usage } from '../providers/types.js';
import { queryOne } from '../db/types.js';
import { startOfDay } from '../util/time.js';

export class BudgetExceededError extends Error {
  constructor(
    public readonly scope: 'daily' | 'run',
    public readonly metric: 'tokens' | 'usd',
    public readonly used: number,
    public readonly limit: number,
  ) {
    super(
      `Бюджет исчерпан (${scope === 'daily' ? 'дневной' : 'на команду'} лимит ${metric === 'tokens' ? 'токенов' : 'долларов'}: ` +
        `${fmt(used, metric)} из ${fmt(limit, metric)}). Работа остановлена.`,
    );
    this.name = 'BudgetExceededError';
  }
}

function fmt(n: number, metric: 'tokens' | 'usd'): string {
  return metric === 'usd' ? `$${n.toFixed(4)}` : String(Math.round(n));
}

export interface RunScope {
  conversationId: string;
  /** Начало «команды»: для чата — время последнего сообщения пользователя, для задачи — начало запуска. */
  since: Date;
  /** Переопределение лимитов команды (например, у задачи). */
  maxTokens?: number;
  maxUsd?: number;
}

export interface UsageTotals {
  tokens: number;
  usd: number;
}

/** Лимит ≤ 0 означает «без лимита». */
const active = (limit: number | undefined): limit is number => typeof limit === 'number' && limit > 0;

export class BudgetService {
  constructor(private readonly ctx: AppContext) {}

  async dailyUsage(now = this.ctx.clock()): Promise<UsageTotals> {
    const since = startOfDay(now, this.ctx.config.timezone);
    return this.sum('created_at >= $1', [since]);
  }

  async runUsage(scope: Pick<RunScope, 'conversationId' | 'since'>): Promise<UsageTotals> {
    return this.sum('conversation_id = $1 and created_at >= $2', [scope.conversationId, scope.since]);
  }

  private async sum(where: string, params: unknown[]): Promise<UsageTotals> {
    const row = await queryOne<{ tokens: number; usd: number }>(
      this.ctx.db,
      `select coalesce(sum(prompt_tokens + completion_tokens), 0)::float8 as tokens,
              coalesce(sum(cost_usd), 0)::float8 as usd
         from usage_log where ${where}`,
      params,
    );
    return { tokens: Number(row?.tokens ?? 0), usd: Number(row?.usd ?? 0) };
  }

  /** Жёсткий стоп: бросает BudgetExceededError, если лимит уже достигнут. */
  async assertCanSpend(scope?: RunScope): Promise<void> {
    const limits = await this.ctx.settings.getBudget();
    const daily = await this.dailyUsage();
    if (active(limits.dailyTokens) && daily.tokens >= limits.dailyTokens) {
      throw new BudgetExceededError('daily', 'tokens', daily.tokens, limits.dailyTokens);
    }
    if (active(limits.dailyUsd) && daily.usd >= limits.dailyUsd) {
      throw new BudgetExceededError('daily', 'usd', daily.usd, limits.dailyUsd);
    }
    if (!scope) return;
    const run = await this.runUsage(scope);
    const maxTokens = scope.maxTokens ?? limits.runTokens;
    const maxUsd = scope.maxUsd ?? limits.runUsd;
    if (active(maxTokens) && run.tokens >= maxTokens) {
      throw new BudgetExceededError('run', 'tokens', run.tokens, maxTokens);
    }
    if (active(maxUsd) && run.usd >= maxUsd) {
      throw new BudgetExceededError('run', 'usd', run.usd, maxUsd);
    }
  }

  /** Сколько токенов ещё можно потратить — ограничивает max_tokens запроса, чтобы не перелетать лимит. */
  async remainingTokens(scope?: RunScope): Promise<number | undefined> {
    const limits = await this.ctx.settings.getBudget();
    const candidates: number[] = [];
    if (active(limits.dailyTokens)) candidates.push(limits.dailyTokens - (await this.dailyUsage()).tokens);
    if (scope) {
      const maxTokens = scope.maxTokens ?? limits.runTokens;
      if (active(maxTokens)) candidates.push(maxTokens - (await this.runUsage(scope)).tokens);
    }
    return candidates.length ? Math.max(0, Math.min(...candidates)) : undefined;
  }

  computeCost(model: string, usage: Usage): number {
    if (typeof usage.costUsd === 'number') return usage.costUsd;
    const prices = this.ctx.config.prices;
    const price = prices[model] ?? Object.entries(prices).find(([k]) => model.startsWith(k))?.[1];
    if (!price) return 0;
    return (usage.promptTokens * price.in + usage.completionTokens * price.out) / 1_000_000;
  }

  async record(entry: {
    provider: string;
    model: string;
    usage: Usage;
    conversationId?: string;
    taskId?: string;
  }): Promise<void> {
    const cost = this.computeCost(entry.model, entry.usage);
    await this.ctx.db.query(
      `insert into usage_log (provider, model, prompt_tokens, completion_tokens, cost_usd, conversation_id, task_id)
       values ($1, $2, $3, $4, $5, $6, $7)`,
      [
        entry.provider,
        entry.model,
        Math.round(entry.usage.promptTokens),
        Math.round(entry.usage.completionTokens),
        cost,
        entry.conversationId ?? null,
        entry.taskId ?? null,
      ],
    );
  }

  async summary() {
    const [limits, daily] = await Promise.all([this.ctx.settings.getBudget(), this.dailyUsage()]);
    const byProvider = await this.ctx.db.query<{ provider: string; tokens: number; usd: number; calls: number }>(
      `select provider,
              coalesce(sum(prompt_tokens + completion_tokens), 0)::float8 as tokens,
              coalesce(sum(cost_usd), 0)::float8 as usd,
              count(*)::int as calls
         from usage_log where created_at >= $1 group by provider order by tokens desc`,
      [startOfDay(this.ctx.clock(), this.ctx.config.timezone)],
    );
    return { limits, daily, byProvider };
  }
}
