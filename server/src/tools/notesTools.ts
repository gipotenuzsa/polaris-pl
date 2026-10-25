import { z } from 'zod';
import { dayKey } from '../util/time.js';
import { parseDateTime, resolveId, shortId } from './util.js';
import { defineTool, type AnyTool } from './types.js';

const snippet = (s: string, n = 120) => (s.length > n ? `${s.slice(0, n)}…` : s).replace(/\s+/g, ' ');

export function notesTools(): AnyTool[] {
  return [
    defineTool({
      name: 'note_create',
      description: 'Создаёт заметку (заголовок и текст).',
      schema: z.object({ title: z.string().min(1).max(200), body: z.string().max(20_000).default('') }),
      describe: (a) => `Создать заметку «${a.title}»`,
      async execute(a, { app }) {
        const note = await app.notes.create(a.title, a.body);
        return {
          content: `Заметка создана (id: ${shortId(note.id)}).`,
          summary: `Создана заметка «${note.title}»`,
          undo: { kind: 'note.create', data: { id: note.id } },
        };
      },
    }),
    defineTool({
      name: 'note_list',
      description: 'Список заметок; с query — поиск по заголовку и тексту.',
      schema: z.object({ query: z.string().max(200).optional(), limit: z.number().int().min(1).max(50).optional() }),
      describe: (a) => (a.query ? `Поиск заметок «${a.query}»` : 'Список заметок'),
      async execute(a, { app }) {
        const rows = await app.notes.list(a.query, a.limit ?? 20);
        if (!rows.length) return { content: 'Заметок нет.', summary: 'Заметки: 0' };
        return {
          content: rows.map((n) => `- ${shortId(n.id)} | ${n.title} | ${snippet(n.body)}`).join('\n'),
          summary: `Заметки: ${rows.length}`,
        };
      },
    }),
    defineTool({
      name: 'note_read',
      description: 'Возвращает полный текст заметки по id.',
      schema: z.object({ id: z.string().min(4) }),
      describe: (a) => `Прочитать заметку ${a.id}`,
      async execute(a, { app }) {
        const note = await app.notes.get(await resolveId(app, 'notes', a.id));
        return { content: `# ${note.title}\n\n${note.body}`, summary: `Прочитана заметка «${note.title}»` };
      },
    }),
    defineTool({
      name: 'note_update',
      description: 'Меняет заголовок и/или текст заметки.',
      schema: z.object({
        id: z.string().min(4),
        title: z.string().min(1).max(200).optional(),
        body: z.string().max(20_000).optional(),
      }),
      describe: (a) => `Изменить заметку ${a.id}`,
      async execute(a, { app }) {
        const id = await resolveId(app, 'notes', a.id);
        const before = await app.notes.get(id);
        const after = await app.notes.update(id, { title: a.title, body: a.body });
        return {
          content: 'Заметка обновлена.',
          summary: `Изменена заметка «${after.title}»`,
          undo: { kind: 'note.update', data: { id, title: before.title, body: before.body } },
        };
      },
    }),
    defineTool({
      name: 'note_delete',
      description: 'Удаляет заметку. Требует подтверждения пользователя.',
      schema: z.object({ id: z.string().min(4) }),
      approval: () => 'Удаление заметки',
      describe: (a) => `Удалить заметку ${a.id}`,
      async execute(a, { app }) {
        const id = await resolveId(app, 'notes', a.id);
        const row = await app.notes.remove(id);
        return {
          content: `Заметка «${row.title}» удалена.`,
          summary: `Удалена заметка «${row.title}»`,
          undo: { kind: 'note.delete', data: { row } },
        };
      },
    }),
    defineTool({
      name: 'reminder_create',
      description:
        'Создаёт напоминание: пользователь получит уведомление в назначенное время. Укажи либо at (ISO 8601, без пояса — по времени пользователя), либо inMinutes.',
      schema: z
        .object({
          text: z.string().min(1).max(500),
          at: z.string().optional().describe('Например 2026-03-01T09:30'),
          inMinutes: z.number().int().min(1).max(525_600).optional(),
        })
        .refine((v) => Boolean(v.at) !== (v.inMinutes !== undefined), 'Нужно указать ровно одно: at или inMinutes'),
      describe: (a) => `Напоминание «${a.text}» ${a.at ?? `через ${a.inMinutes} мин`}`,
      async execute(a, { app }) {
        const now = app.clock();
        const due = a.at
          ? parseDateTime(a.at, app.config.timezone)
          : new Date(now.getTime() + (a.inMinutes ?? 0) * 60_000);
        if (due.getTime() <= now.getTime()) throw new Error('Время напоминания уже прошло');
        const r = await app.reminders.create(a.text, due);
        return {
          content: `Напоминание создано на ${due.toISOString()} (id: ${shortId(r.id)}).`,
          summary: `Напоминание «${r.text}» на ${due.toISOString()}`,
          undo: { kind: 'reminder.create', data: { id: r.id } },
        };
      },
    }),
    defineTool({
      name: 'reminder_list',
      description: 'Список активных напоминаний.',
      schema: z.object({}),
      describe: () => 'Список напоминаний',
      async execute(_a, { app }) {
        const rows = await app.reminders.list('pending');
        if (!rows.length) return { content: 'Активных напоминаний нет.', summary: 'Напоминания: 0' };
        return {
          content: rows.map((r) => `- ${shortId(r.id)} | ${new Date(r.due_at).toISOString()} | ${r.text}`).join('\n'),
          summary: `Напоминания: ${rows.length}`,
        };
      },
    }),
    defineTool({
      name: 'reminder_cancel',
      description: 'Отменяет напоминание по id.',
      schema: z.object({ id: z.string().min(4) }),
      describe: (a) => `Отменить напоминание ${a.id}`,
      async execute(a, { app }) {
        const id = await resolveId(app, 'reminders', a.id);
        const r = await app.reminders.cancel(id);
        return {
          content: 'Напоминание отменено.',
          summary: `Отменено напоминание «${r.text}»`,
          undo: { kind: 'reminder.cancel', data: { id } },
        };
      },
    }),
    defineTool({
      name: 'get_time',
      description: 'Текущие дата и время в часовом поясе пользователя.',
      schema: z.object({}),
      describe: () => 'Текущее время',
      async execute(_a, { app }) {
        const now = app.clock();
        const tz = app.config.timezone;
        const local = new Intl.DateTimeFormat('ru-RU', { timeZone: tz, dateStyle: 'full', timeStyle: 'medium' }).format(
          now,
        );
        return {
          content: `${local} (${tz}); ISO: ${now.toISOString()}; день: ${dayKey(now, tz)}`,
          summary: 'Запрошено время',
        };
      },
    }),
  ];
}
