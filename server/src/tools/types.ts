import type { z } from 'zod';
import type { AppContext } from '../context.js';

export interface UndoInfo {
  kind: string;
  data: Record<string, unknown>;
}

export interface ToolResult {
  /** Текст, который увидит модель. */
  content: string;
  /** Короткая сводка для журнала действий. */
  summary?: string;
  /** Как откатить действие (если возможно). Без секретов. */
  undo?: UndoInfo;
}

export interface ToolRunContext {
  app: AppContext;
  conversationId?: string;
  taskId?: string;
  signal?: AbortSignal;
}

export interface ToolDefinition<S extends z.ZodType> {
  name: string;
  description: string;
  schema: S;
  /** Если вернёт строку — вызов выполняется только после подтверждения пользователя; строка — причина. */
  approval?: (args: z.infer<S>, ctx: ToolRunContext) => Promise<string | null> | string | null;
  timeoutMs?: number;
  /** Человекочитаемое описание вызова — для подтверждения и журнала. */
  describe: (args: z.infer<S>) => string;
  execute: (args: z.infer<S>, ctx: ToolRunContext) => Promise<ToolResult>;
}

/** Тип-стёртая форма инструмента для реестра. */
export interface AnyTool {
  name: string;
  description: string;
  schema: z.ZodType;
  approval?: (args: unknown, ctx: ToolRunContext) => Promise<string | null> | string | null;
  timeoutMs?: number;
  describe: (args: unknown) => string;
  execute: (args: unknown, ctx: ToolRunContext) => Promise<ToolResult>;
}

export function defineTool<S extends z.ZodType>(def: ToolDefinition<S>): AnyTool {
  return def as unknown as AnyTool;
}
