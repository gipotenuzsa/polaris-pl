import { redact } from '../crypto/redact.js';
import type { AppContext } from '../context.js';
import { errorMessage } from '../util/errors.js';
import type { AnyTool, ToolResult, ToolRunContext } from './types.js';

/** Верхняя граница результата инструмента, попадающего в контекст модели. */
export const MAX_TOOL_OUTPUT = 20_000;

export interface ExecOutcome {
  ok: boolean;
  content: string;
}

export function truncate(text: string, max = MAX_TOOL_OUTPUT): string {
  return text.length > max ? `${text.slice(0, max)}\n… [обрезано: ещё ${text.length - max} симв.]` : text;
}

function zodMessage(error: { issues: { path: PropertyKey[]; message: string }[] }): string {
  return error.issues.map((i) => `${i.path.map(String).join('.') || 'аргументы'}: ${i.message}`).join('; ');
}

/** Проверка аргументов по схеме. */
export function parseArgs(tool: AnyTool, raw: unknown): { ok: true; args: unknown } | { ok: false; error: string } {
  const parsed = tool.schema.safeParse(raw);
  if (!parsed.success) return { ok: false, error: zodMessage(parsed.error) };
  return { ok: true, args: parsed.data };
}

/**
 * Выполняет инструмент: валидация → таймаут → журнал действий (без секретов).
 * Подтверждение проверяется выше (агент / сервис подтверждений); сюда приходят уже разрешённые вызовы.
 */
export async function executeTool(
  app: AppContext,
  tool: AnyTool,
  rawArgs: unknown,
  run: Omit<ToolRunContext, 'app'> & { approvalId?: string },
): Promise<ExecOutcome> {
  const checked = parseArgs(tool, rawArgs);
  const logBase = {
    tool: tool.name,
    conversationId: run.conversationId,
    taskId: run.taskId,
    approvalId: run.approvalId,
  };
  if (!checked.ok) {
    await app.actions.log({
      ...logBase,
      args: rawArgs,
      summary: `Неверные аргументы: ${checked.error}`,
      status: 'error',
    });
    return { ok: false, content: `Ошибка: неверные аргументы вызова ${tool.name} — ${checked.error}` };
  }

  const timeoutMs = tool.timeoutMs ?? app.config.agent.toolTimeoutMs;
  const timeout = AbortSignal.timeout(timeoutMs);
  const signal = run.signal ? AbortSignal.any([run.signal, timeout]) : timeout;
  const description = safeDescribe(tool, checked.args);

  try {
    const result: ToolResult = await Promise.race([
      tool.execute(checked.args, { app, conversationId: run.conversationId, taskId: run.taskId, signal }),
      new Promise<never>((_, reject) => {
        signal.addEventListener(
          'abort',
          () => reject(new Error(`Таймаут инструмента (${Math.round(timeoutMs / 1000)} с)`)),
          {
            once: true,
          },
        );
      }),
    ]);
    await app.actions.log({
      ...logBase,
      args: checked.args,
      summary: result.summary ?? description,
      status: 'ok',
      undo: result.undo,
    });
    return { ok: true, content: truncate(result.content) };
  } catch (err) {
    const message = errorMessage(err);
    app.log.warn({ tool: tool.name, err: message }, 'Ошибка инструмента');
    await app.actions.log({
      ...logBase,
      args: checked.args,
      summary: `${description} — ошибка: ${message}`,
      status: 'error',
    });
    return { ok: false, content: `Ошибка инструмента ${tool.name}: ${message}` };
  }
}

export function safeDescribe(tool: AnyTool, args: unknown): string {
  try {
    return String(redact(tool.describe(args)));
  } catch {
    return tool.name;
  }
}
