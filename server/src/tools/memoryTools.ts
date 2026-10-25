import { z } from 'zod';
import { resolveId, shortId } from './util.js';
import { defineTool, type AnyTool } from './types.js';

const kind = z.enum(['fact', 'preference']);

export function memoryTools(): AnyTool[] {
  return [
    defineTool({
      name: 'memory_save',
      description:
        'Сохраняет в долгосрочную память устойчивый факт о пользователе (fact) или его предпочтение (preference). ' +
        'Одно короткое самодостаточное предложение. Никаких паролей, ключей и номеров карт.',
      schema: z.object({ kind, content: z.string().min(3).max(500) }),
      describe: (a) => `Запомнить (${a.kind}): ${a.content}`,
      async execute(a, { app, conversationId, taskId }) {
        const source = taskId
          ? `agent:task:${taskId.slice(0, 8)}`
          : conversationId
            ? `agent:chat:${conversationId.slice(0, 8)}`
            : 'agent';
        const { row, created } = await app.memory.create({ kind: a.kind, content: a.content, source });
        return {
          content: created ? `Запомнил (id: ${shortId(row.id)}).` : 'Такая запись уже есть в памяти.',
          summary: `${created ? 'Сохранено в память' : 'Уже в памяти'}: ${row.content}`,
          undo: created ? { kind: 'memory.create', data: { id: row.id } } : undefined,
        };
      },
    }),
    defineTool({
      name: 'memory_search',
      description: 'Ищет в долгосрочной памяти по ключевым словам.',
      schema: z.object({ query: z.string().min(1).max(200) }),
      describe: (a) => `Поиск в памяти «${a.query}»`,
      async execute(a, { app }) {
        const rows = await app.memory.search(a.query, 10);
        if (!rows.length) return { content: 'В памяти ничего не найдено.', summary: 'Память: 0 записей' };
        return {
          content: rows.map((m) => `- ${shortId(m.id)} [${m.kind}] ${m.content}`).join('\n'),
          summary: `Память: ${rows.length} записей`,
        };
      },
    }),
    defineTool({
      name: 'memory_update',
      description: 'Меняет текст записи памяти по id.',
      schema: z.object({ id: z.string().min(4), content: z.string().min(3).max(500) }),
      describe: (a) => `Изменить запись памяти ${a.id}`,
      async execute(a, { app }) {
        const id = await resolveId(app, 'memory', a.id);
        const before = await app.memory.get(id);
        const after = await app.memory.update(id, { content: a.content });
        return {
          content: 'Запись обновлена.',
          summary: `Изменена запись памяти: ${after.content}`,
          undo: { kind: 'memory.update', data: { id, content: before.content, kind: before.kind } },
        };
      },
    }),
    defineTool({
      name: 'memory_delete',
      description: 'Удаляет запись памяти. Требует подтверждения пользователя.',
      schema: z.object({ id: z.string().min(4) }),
      approval: () => 'Удаление записи из памяти',
      describe: (a) => `Удалить запись памяти ${a.id}`,
      async execute(a, { app }) {
        const id = await resolveId(app, 'memory', a.id);
        const row = await app.memory.remove(id);
        return {
          content: 'Запись удалена.',
          summary: `Удалена запись памяти: ${row.content}`,
          undo: { kind: 'memory.delete', data: { row } },
        };
      },
    }),
  ];
}
