import { Appearance, Platform } from 'react-native';

/** Шрифт с засечками для заголовков и текста ответов: на iPhone — New York/Georgia, на Android — системный serif. */
export const fonts = {
  serif: Platform.select({
    web: "ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif",
    ios: 'System',
    default: 'sans-serif',
  }) as string,
};

export type ThemePreference = 'system' | 'light' | 'dark';
const THEME_KEY = 'chatgtt.theme';

/** Выбор темы читается один раз при запуске: на вебе — из localStorage, иначе — по настройке системы. */
function readPreference(): ThemePreference {
  try {
    if (Platform.OS === 'web') {
      const v = globalThis.localStorage?.getItem(THEME_KEY);
      if (v === 'light' || v === 'dark') return v;
    }
  } catch {
    /* localStorage недоступен */
  }
  return 'system';
}
export const themePreference: ThemePreference = readPreference();

function systemDark(): boolean {
  if (Platform.OS === 'web') return !!globalThis.matchMedia?.('(prefers-color-scheme: dark)').matches;
  return Appearance.getColorScheme() === 'dark';
}
export const isDark = themePreference === 'dark' || (themePreference === 'system' && systemDark());

/** Сохраняет выбор и перезагружает страницу (на телефоне без веба тема следует за системой). */
export function setThemePreference(value: ThemePreference): void {
  if (Platform.OS !== 'web') return;
  try {
    if (value === 'system') globalThis.localStorage?.removeItem(THEME_KEY);
    else globalThis.localStorage?.setItem(THEME_KEY, value);
  } catch {
    /* ignore */
  }
  globalThis.location?.reload();
}

const light = {
  bg: '#FFFFFF',
  sidebar: '#F9F9F9',
  surface: '#FFFFFF',
  surface2: '#F4F4F4',
  border: '#E5E5E5',
  text: '#0D0D0D',
  muted: '#6B6B6B',
  accent: '#10A37F',
  ink: '#0D0D0D',
  accentText: '#FFFFFF',
  success: '#10A37F',
  warn: '#B7791F',
  warnBg: '#F6EBCF',
  attention: '#D97706',
  danger: '#EF4444',
  dangerBg: '#FEE2E2',
  userBubble: '#F4F4F4',
  hover: '#ECECEC',
  chip: '#F7F7F7',
  overlay: 'rgba(0,0,0,0.3)',
};

/** Тёмная палитра ChatGPT: графит #212121, боковая панель #171717, поле ввода #2F2F2F. */
const dark: typeof light = {
  bg: '#212121',
  sidebar: '#171717',
  surface: '#2F2F2F',
  surface2: '#303030',
  border: '#3A3A3A',
  text: '#ECECEC',
  muted: '#A1A1A1',
  accent: '#10A37F',
  ink: '#ECECEC',
  accentText: '#171717',
  success: '#34D399',
  warn: '#F59E0B',
  warnBg: '#3A2E12',
  attention: '#F59E0B',
  danger: '#F87171',
  dangerBg: '#3B1F1F',
  userBubble: '#303030',
  hover: '#2A2A2A',
  chip: '#2A2A2A',
  overlay: 'rgba(0,0,0,0.55)',
};

export const colors = isDark ? dark : light;

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
