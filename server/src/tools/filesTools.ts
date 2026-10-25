import { z } from 'zod';
import { normalizeUserPath } from '../storage/types.js';
import { defineTool, type AnyTool } from './types.js';

const MAX_FILE_BYTES = 1_000_000;

const stamp = () => new Date().toISOString().replace(/[:.]/g, '-');

/** Файлы в Supabase Storage. Перезапись и удаление — только с подтверждением; прежнее содержимое сохраняется для отката. */
export function filesTools(): AnyTool[] {
  return [
    defineTool({
      name: 'file_list',
      description: 'Список файлов и каталогов (один уровень). path — каталог, по умолчанию корень.',
      schema: z.object({ path: z.string().max(500).optional() }),
      describe: (a) => `Список файлов ${a.path ?? '/'}`,
      async execute(a, { app }) {
        const prefix = a.path ? normalizeUserPath(a.path) : '';
        const entries = (await app.files.list(prefix)).filter((e) => !(prefix === '' && e.name.startsWith('_')));
        if (!entries.length) return { content: 'Пусто.', summary: `Каталог ${prefix || '/'}: пусто` };
        return {
          content: entries.map((e) => (e.isDir ? `${e.path}/` : `${e.path} (${e.size} Б)`)).join('\n'),
          summary: `Каталог ${prefix || '/'}: ${entries.length}`,
        };
      },
    }),
    defineTool({
      name: 'file_read',
      description: 'Читает текстовый файл целиком (до 1 МБ).',
      schema: z.object({
        path: z.string().min(1).max(500),
        maxChars: z.number().int().min(100).max(30_000).optional(),
      }),
      describe: (a) => `Прочитать файл ${a.path}`,
      async execute(a, { app }) {
        const data = await app.files.read(normalizeUserPath(a.path));
        if (!data) throw new Error(`Файл не найден: ${a.path}`);
        if (data.includes(0))
          return { content: `Двоичный файл, ${data.length} Б — показать нельзя.`, summary: `Прочитан ${a.path}` };
        const text = data.toString('utf8');
        const max = a.maxChars ?? 12_000;
        return {
          content: text.length > max ? `${text.slice(0, max)}\n… [обрезано, всего ${text.length} симв.]` : text,
          summary: `Прочитан файл ${a.path}`,
        };
      },
    }),
    defineTool({
      name: 'file_write',
      description:
        'Записывает текстовый файл. Если файл уже существует, перезапись требует подтверждения пользователя.',
      schema: z.object({ path: z.string().min(1).max(500), content: z.string().max(MAX_FILE_BYTES) }),
      async approval(a, { app }) {
        return (await app.files.exists(normalizeUserPath(a.path))) ? `Перезапись существующего файла ${a.path}` : null;
      },
      describe: (a) => `Записать файл ${a.path} (${a.content.length} симв.)`,
      async execute(a, { app }) {
        const path = normalizeUserPath(a.path);
        const prev = await app.files.read(path);
        let backup: string | undefined;
        if (prev) {
          backup = `_versions/${stamp()}/${path}`;
          await app.files.write(backup, prev);
        }
        await app.files.write(path, a.content, 'text/plain; charset=utf-8');
        return {
          content: `Файл ${path} записан (${a.content.length} симв.).`,
          summary: `${prev ? 'Перезаписан' : 'Создан'} файл ${path}`,
          undo: { kind: 'file.write', data: { path, backup: backup ?? null } },
        };
      },
    }),
    defineTool({
      name: 'file_delete',
      description: 'Удаляет файл (уходит в корзину). Требует подтверждения пользователя.',
      schema: z.object({ path: z.string().min(1).max(500) }),
      approval: (a) => `Удаление файла ${a.path}`,
      describe: (a) => `Удалить файл ${a.path}`,
      async execute(a, { app }) {
        const path = normalizeUserPath(a.path);
        if (!(await app.files.exists(path))) throw new Error(`Файл не найден: ${a.path}`);
        const trash = `_trash/${stamp()}/${path}`;
        await app.files.move(path, trash);
        return {
          content: `Файл ${path} удалён.`,
          summary: `Удалён файл ${path}`,
          undo: { kind: 'file.delete', data: { path, trash } },
        };
      },
    }),
  ];
}
