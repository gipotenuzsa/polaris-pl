import { z } from 'zod';
import type { AppContext } from '../context.js';
import { json, queryOne } from '../db/types.js';
import { isValidTimeZone, parseHHMM } from '../util/time.js';

export const budgetSchema = z.object({
  dailyTokens: z.number().int().min(0).max(1_000_000_000),
  dailyUsd: z.number().min(0).max(100_000),
  runTokens: z.number().int().min(0).max(1_000_000_000),
  runUsd: z.number().min(0).max(100_000),
});
export type BudgetSettings = z.infer<typeof budgetSchema>;

export const morningSchema = z.object({
  enabled: z.boolean(),
  time: z.string().refine((v) => parseHHMM(v) !== null, 'Ожидается время HH:MM'),
  timezone: z.string().refine(isValidTimeZone, 'Неизвестный часовой пояс'),
});
export type MorningSettings = z.infer<typeof morningSchema> & { lastRunDate?: string };

export const agentSchema = z.object({
  instructions: z.string().max(4000),
});
export type AgentSettings = z.infer<typeof agentSchema>;

export const chatgptSettingsSchema = z.object({
  enabled: z.boolean(),
  model: z.string().min(1).max(100),
});
export type ChatGptSettings = z.infer<typeof chatgptSettingsSchema>;

export class SettingsService {
  constructor(private readonly ctx: AppContext) {}

  async get<T>(key: string, fallback: T): Promise<T> {
    const row = await queryOne<{ value: T }>(this.ctx.db, 'select value from settings where key = $1', [key]);
    if (row === undefined) return fallback;
    if (fallback && typeof fallback === 'object' && !Array.isArray(fallback)) {
      return { ...fallback, ...(row.value as object) } as T;
    }
    return row.value;
  }

  async set(key: string, value: unknown): Promise<void> {
    await this.ctx.db.query(
      `insert into settings (key, value, updated_at) values ($1, $2::jsonb, now())
       on conflict (key) do update set value = excluded.value, updated_at = now()`,
      [key, json(value)],
    );
  }

  getBudget(): Promise<BudgetSettings> {
    return this.get<BudgetSettings>('budget', { ...this.ctx.config.budget });
  }

  getMorning(): Promise<MorningSettings> {
    return this.get<MorningSettings>('morning', {
      enabled: false,
      time: '08:00',
      timezone: this.ctx.config.timezone,
    });
  }

  getAgent(): Promise<AgentSettings> {
    return this.get<AgentSettings>('agent', { instructions: '' });
  }

  getChatGpt(): Promise<ChatGptSettings> {
    return this.get<ChatGptSettings>('chatgpt', {
      enabled: false,
      model: this.ctx.config.providers.chatgpt.defaultModel,
    });
  }
}
