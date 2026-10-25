import type { AppContext } from '../context.js';
import type { MemoryRow } from '../services/memory.js';
import type { NoteRow } from '../services/notes.js';

type Undoer = (app: AppContext, data: Record<string, unknown>) => Promise<string>;

/** Откат действий. Ключ — UndoInfo.kind, который инструмент вернул при выполнении. */
export const undoers: Record<string, Undoer> = {
  'note.create': async (app, d) => {
    await app.notes.remove(String(d.id)).catch(() => undefined);
    return 'Заметка удалена';
  },
  'note.update': async (app, d) => {
    await app.notes.update(String(d.id), { title: String(d.title), body: String(d.body) });
    return 'Прежний текст заметки восстановлен';
  },
  'note.delete': async (app, d) => {
    await app.notes.restore(d.row as NoteRow);
    return 'Заметка восстановлена';
  },
  'memory.create': async (app, d) => {
    await app.memory.remove(String(d.id)).catch(() => undefined);
    return 'Запись памяти удалена';
  },
  'memory.update': async (app, d) => {
    await app.memory.update(String(d.id), { content: String(d.content), kind: d.kind as 'fact' | 'preference' });
    return 'Прежняя запись памяти восстановлена';
  },
  'memory.delete': async (app, d) => {
    await app.memory.restore(d.row as MemoryRow);
    return 'Запись памяти восстановлена';
  },
  'reminder.create': async (app, d) => {
    await app.reminders.remove(String(d.id));
    return 'Напоминание удалено';
  },
  'reminder.cancel': async (app, d) => {
    await app.reminders.reactivate(String(d.id));
    return 'Напоминание снова активно';
  },
  'file.write': async (app, d) => {
    const path = String(d.path);
    if (typeof d.backup === 'string') {
      const prev = await app.files.read(d.backup);
      if (!prev) throw new Error('Резервная копия файла не найдена');
      await app.files.write(path, prev);
      return `Файл ${path} возвращён к прежней версии`;
    }
    await app.files.remove(path);
    return `Файл ${path} удалён`;
  },
  'file.delete': async (app, d) => {
    await app.files.move(String(d.trash), String(d.path));
    return `Файл ${String(d.path)} восстановлен из корзины`;
  },
  'task.create': async (app, d) => {
    await app.tasks.cancel(String(d.id));
    return 'Задача отменена';
  },
};
