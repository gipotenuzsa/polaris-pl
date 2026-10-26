import type { AppContext } from '../context.js';
import type { ChatResponse, ToolCall } from '../providers/types.js';
import { AllProvidersFailedError } from '../providers/chain.js';
import { BudgetExceededError, type RunScope } from '../services/budget.js';
import { executeTool, parseArgs, safeDescribe } from '../tools/exec.js';
import { schemaToJson } from '../tools/registry.js';
import type { AnyTool } from '../tools/types.js';
import { errorMessage } from '../util/errors.js';
import { buildMessages } from './context.js';

export interface RunHooks {
  onModel?(resp: ChatResponse): Promise<void> | void;
  onToolDone?(call: ToolCall, result: { ok: boolean; content: string }): Promise<void> | void;
  onApproval?(call: ToolCall, approvalId: string, summary: string): Promise<void> | void;
}

export interface RunOptions {
  conversationId: string;
  system: string;
  /** Начало «команды» для покомандного лимита бюджета. */
  since: Date;
  taskId?: string;
  maxSteps?: number;
  budget?: { maxTokens?: number; maxUsd?: number };
  signal?: AbortSignal;
  hooks?: RunHooks;
  /** Текст ответа модели по мере генерации (стриминг в чат). */
  onText?: (delta: string) => void;
  /** Вызывается, когда ответ модели сохранён или попытка закончилась — буфер стриминга можно сбросить. */
  onTextReset?: () => void;
  toolFilter?: (tool: AnyTool) => boolean;
}

export type RunOutcome =
  | { status: 'done'; text: string }
  | { status: 'awaiting_approval'; approvalIds: string[] }
  | { status: 'budget_exceeded'; message: string }
  | { status: 'max_steps'; message: string }
  | { status: 'failed'; error: string };

const MAX_OUTPUT_TOKENS = 8192;

/**
 * Цикл агента: модель → вызовы инструментов → результаты → модель…
 * Состояние целиком живёт в таблице messages, поэтому цикл можно остановить на подтверждении
 * и продолжить позже (или после перезапуска сервера) тем же вызовом.
 */
export async function runAgent(app: AppContext, opts: RunOptions): Promise<RunOutcome> {
  const { conversationId, taskId } = opts;
  const maxSteps = opts.maxSteps ?? app.config.agent.maxSteps;
  const scope: RunScope = {
    conversationId,
    since: opts.since,
    maxTokens: opts.budget?.maxTokens,
    maxUsd: opts.budget?.maxUsd,
  };
  const tools = app.tools.all().filter(opts.toolFilter ?? (() => true));
  const toolMap = new Map(tools.map((t) => [t.name, t]));
  const specs = tools.map((t) => ({ name: t.name, description: t.description, parameters: schemaToJson(t.schema) }));

  const say = (content: string) =>
    app.conversations.add({ conversationId, role: 'assistant', content, status: 'error' }).then(() => undefined);

  await app.conversations.repairDanglingToolCalls(conversationId);

  for (let step = 0; step < maxSteps; step++) {
    if (opts.signal?.aborted) {
      if (step > 0) await say('⏹ Остановлено.');
      return { status: 'failed', error: 'Остановлено' };
    }

    const rows = await app.conversations.messages(conversationId, 0, 400);
    const pending = rows.filter((r) => r.role === 'tool' && r.status === 'pending');
    if (pending.length > 0) {
      return {
        status: 'awaiting_approval',
        approvalIds: pending.flatMap((r) => (r.approval_id ? [r.approval_id] : [])),
      };
    }
    const last = rows[rows.length - 1];
    if (step === 0 && last?.role === 'assistant' && !last.tool_calls?.length) {
      return { status: 'done', text: last.content }; // отвечать не на что
    }

    try {
      await app.budget.assertCanSpend(scope);
    } catch (err) {
      if (err instanceof BudgetExceededError) {
        await say(`⛔ ${err.message}`);
        return { status: 'budget_exceeded', message: err.message };
      }
      throw err;
    }

    const remaining = await app.budget.remainingTokens(scope);
    const messages = buildMessages(opts.system, rows, app.config.agent.contextTokens);

    let resp;
    try {
      resp = await app.providers.chat({
        messages,
        tools: specs,
        maxTokens: Math.min(MAX_OUTPUT_TOKENS, remaining ?? MAX_OUTPUT_TOKENS),
        signal: opts.signal,
        onText: opts.onText,
      });
    } catch (err) {
      opts.onTextReset?.();
      if (opts.signal?.aborted) {
        await say('⏹ Остановлено.');
        return { status: 'failed', error: 'Остановлено' };
      }
      const message = err instanceof AllProvidersFailedError ? err.message : errorMessage(err);
      await say(`⚠️ Не удалось получить ответ модели. ${message}`);
      return { status: 'failed', error: message };
    }

    await app.budget.record({ provider: resp.provider, model: resp.model, usage: resp.usage, conversationId, taskId });
    await app.conversations.add({
      conversationId,
      role: 'assistant',
      content: resp.content,
      toolCalls: resp.toolCalls,
      provider: resp.provider,
      model: resp.model,
    });
    opts.onTextReset?.();
    await opts.hooks?.onModel?.(resp);

    if (resp.toolCalls.length === 0) return { status: 'done', text: resp.content };

    const approvalIds: string[] = [];
    for (const call of resp.toolCalls) {
      const addTool = (content: string, status: 'ok' | 'error' | 'pending', approvalId?: string) =>
        app.conversations.add({
          conversationId,
          role: 'tool',
          toolCallId: call.id,
          toolName: call.name,
          content,
          status,
          approvalId,
        });

      const tool = toolMap.get(call.name);
      if (!tool) {
        const content = `Неизвестный инструмент «${call.name}». Доступные: ${[...toolMap.keys()].join(', ')}`;
        await addTool(content, 'error');
        await opts.hooks?.onToolDone?.(call, { ok: false, content });
        continue;
      }
      const checked = parseArgs(tool, call.arguments);
      if (!checked.ok) {
        const content = `Ошибка: неверные аргументы вызова ${tool.name} — ${checked.error}`;
        await addTool(content, 'error');
        await opts.hooks?.onToolDone?.(call, { ok: false, content });
        continue;
      }

      let reason: string | null;
      try {
        reason = (await tool.approval?.(checked.args, { app, conversationId, taskId })) ?? null;
      } catch (err) {
        const content = `Ошибка проверки вызова ${tool.name}: ${errorMessage(err)}`;
        await addTool(content, 'error');
        await opts.hooks?.onToolDone?.(call, { ok: false, content });
        continue;
      }

      if (reason) {
        const summary = `${safeDescribe(tool, checked.args)} — ${reason}`;
        const approval = await app.approvals.create({
          action: tool.name,
          summary,
          args: checked.args,
          toolCallId: call.id,
          conversationId,
          taskId,
        });
        await addTool('', 'pending', approval.id);
        approvalIds.push(approval.id);
        await opts.hooks?.onApproval?.(call, approval.id, summary);
        continue;
      }

      const result = await executeTool(app, tool, checked.args, { conversationId, taskId, signal: opts.signal });
      await addTool(result.content, result.ok ? 'ok' : 'error');
      await opts.hooks?.onToolDone?.(call, result);
    }

    if (approvalIds.length > 0) return { status: 'awaiting_approval', approvalIds };
  }

  const message = `Достигнут лимит шагов (${maxSteps}). Остановился, чтобы не тратить бюджет впустую.`;
  await say(`⏸ ${message}`);
  return { status: 'max_steps', message };
}
