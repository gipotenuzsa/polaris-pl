export const colors = {
  bg: '#0a1020',
  surface: '#121a30',
  surface2: '#1a2442',
  border: '#27335a',
  text: '#e9eefb',
  muted: '#8f9cbf',
  accent: '#6ea8ff',
  accentText: '#04122b',
  success: '#4ad2a1',
  warn: '#f4c15d',
  danger: '#ff6b7a',
  userBubble: '#1f3d73',
};

export const space = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24 };
export const radius = { sm: 8, md: 12, lg: 18 };

export const TASK_STATUS: Record<string, { label: string; color: string }> = {
  scheduled: { label: 'Запланирована', color: colors.accent },
  in_progress: { label: 'В процессе', color: colors.warn },
  awaiting_approval: { label: 'Ждёт подтверждения', color: '#ff9f6b' },
  done: { label: 'Готово', color: colors.success },
  failed: { label: 'Ошибка', color: colors.danger },
  cancelled: { label: 'Отменена', color: colors.muted },
};

export const TOOL_LABELS: Record<string, string> = {
  web_search: 'Поиск в интернете',
  read_url: 'Чтение страницы',
  browser_read: 'Браузер: чтение',
  browser_act: 'Браузер: действия',
  note_create: 'Новая заметка',
  note_list: 'Список заметок',
  note_read: 'Чтение заметки',
  note_update: 'Правка заметки',
  note_delete: 'Удаление заметки',
  reminder_create: 'Новое напоминание',
  reminder_list: 'Список напоминаний',
  reminder_cancel: 'Отмена напоминания',
  file_list: 'Список файлов',
  file_read: 'Чтение файла',
  file_write: 'Запись файла',
  file_delete: 'Удаление файла',
  memory_save: 'Запомнить',
  memory_search: 'Поиск в памяти',
  memory_update: 'Правка памяти',
  memory_delete: 'Удаление из памяти',
  task_create: 'Фоновая задача',
  task_list: 'Список задач',
  task_cancel: 'Отмена задачи',
  get_time: 'Текущее время',
};

export const toolLabel = (name: string) => TOOL_LABELS[name] ?? name;
