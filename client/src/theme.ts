import { Platform } from 'react-native';

/** Шрифт с засечками для заголовков и текста ответов: на iPhone — New York/Georgia, на Android — системный serif. */
export const fonts = {
  serif: Platform.select({
    web: "ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif",
    ios: 'System',
    default: 'sans-serif',
  }) as string,
};

// Палитра ChatGPT: белый фон, светло-серые панели, зелёный акцент #10A37F.
export const colors = {
  bg: '#FFFFFF',
  sidebar: '#F9F9F9',
  surface: '#FFFFFF',
  surface2: '#F4F4F4',
  border: '#E5E5E5',
  text: '#0D0D0D',
  muted: '#6B6B6B',
  /** терракота: активные элементы, ссылки, индикаторы */
  accent: '#10A37F',
  /** «чернила»: основные кнопки и выбранные чипы */
  ink: '#0D0D0D',
  /** текст на чернильном фоне */
  accentText: '#FFFFFF',
  success: '#10A37F',
  warn: '#B7791F',
  warnBg: '#F6EBCF',
  attention: '#D97706',
  danger: '#EF4444',
  dangerBg: '#FEE2E2',
  userBubble: '#F4F4F4',
};

export const space = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24 };
export const radius = { sm: 10, md: 14, lg: 22 };

/** Мягкая тень — единственная «глубина» в интерфейсе. */
export const shadow = {
  shadowColor: '#000000',
  shadowOpacity: 0.06,
  shadowRadius: 22,
  shadowOffset: { width: 0, height: 8 },
  elevation: 2,
} as const;

export const TASK_STATUS: Record<string, { label: string; color: string }> = {
  scheduled: { label: 'Запланирована', color: colors.accent },
  in_progress: { label: 'В процессе', color: colors.warn },
  awaiting_approval: { label: 'Ждёт подтверждения', color: colors.attention },
  done: { label: 'Готово', color: colors.success },
  failed: { label: 'Ошибка', color: colors.danger },
  cancelled: { label: 'Отменена', color: colors.muted },
};

export const TOOL_LABELS: Record<string, string> = {
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
  history_search: 'Поиск в истории',
  research: 'Исследование',
};

export const toolLabel = (name: string) => TOOL_LABELS[name] ?? name;
