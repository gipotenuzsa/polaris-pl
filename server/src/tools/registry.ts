import { z } from 'zod';
import type { JsonSchema, ToolSpec } from '../providers/types.js';
import type { AnyTool } from './types.js';

export function schemaToJson(schema: z.ZodType): JsonSchema {
  const json = z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' }) as JsonSchema;
  delete json.$schema;
  return json;
}

export class ToolRegistry {
  private readonly tools = new Map<string, AnyTool>();

  constructor(tools: AnyTool[]) {
    for (const t of tools) {
      if (this.tools.has(t.name)) throw new Error(`Дублирующийся инструмент: ${t.name}`);
      this.tools.set(t.name, t);
    }
  }

  get(name: string): AnyTool | undefined {
    return this.tools.get(name);
  }

  all(): AnyTool[] {
    return [...this.tools.values()];
  }

  specs(): ToolSpec[] {
    return this.all().map((t) => ({ name: t.name, description: t.description, parameters: schemaToJson(t.schema) }));
  }
}
