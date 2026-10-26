import { Platform } from 'react-native';

/** Шрифт с засечками для заголовков и текста ответов: на iPhone — New York/Georgia, на Android — системный serif. */
export const fonts = {
  serif: Platform.select({
    web: "ui-serif, 'New York', 'Iowan Old Style', Georgia, 'Times New Roman', serif",
    ios: 'Georgia',
    default: 'serif',
  }) as string,
};

// Тёплая бежевая палитра: бумага, чернила, один терракотовый акцент.
export const colors = {
  bg: '#F5F0E6',
  surface: '#FCFAF5',
  surface2: '#EEE7D9',
  border: '#E7DFCE',
  text: '#2B2620',
  muted: '#8C8272',
  /** терракота: активные элементы, ссылки, индикаторы */
  accent: '#B8613A',
  /** «чернила»: основные кнопки и выбранные чипы */
  ink: '#2B2620',
  /** текст на чернильном фоне */
  accentText: '#FBF7EE',
  success: '#5E8C61',
  warn: '#B7791F',
  warnBg: '#F6EBCF',
  attention: '#C2693F',
  danger: '#B5483A',
  dangerBg: '#F6E1DB',
  userBubble: '#E9DFCB',
};

export const space = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24 };
export const radius = { sm: 10, md: 14, lg: 22 };

/** Мягкая тень — единственная «глубина» в интерфейсе. */
export const shadow = {
  shadowColor: '#5B4A2E',
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
