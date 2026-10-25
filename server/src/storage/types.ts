export interface FileEntry {
  path: string;
  name: string;
  size: number;
  updatedAt?: string;
  isDir: boolean;
}

export interface FileStore {
  write(path: string, data: Buffer | string, contentType?: string): Promise<void>;
  read(path: string): Promise<Buffer | null>;
  exists(path: string): Promise<boolean>;
  /** Содержимое одного уровня каталога. */
  list(prefix?: string): Promise<FileEntry[]>;
  remove(path: string): Promise<void>;
  move(from: string, to: string): Promise<void>;
}

export const RESERVED_PREFIXES = ['_trash', '_versions'];
const MAX_PATH = 512;

/** Нормализует и проверяет путь; бросает ошибку на выходы за корень, пустые сегменты и управляющие символы. */
export function normalizePath(input: string): string {
  if (typeof input !== 'string' || !input.trim()) throw new Error('Пустой путь');
  if (input.includes('\\')) throw new Error('Используйте «/» в путях');
  const parts = input.replace(/^\/+/, '').split('/');
  if (parts.length > 0 && parts[parts.length - 1] === '') parts.pop(); // завершающий «/»
  for (const p of parts) {
    if (p === '' || p === '.' || p === '..') throw new Error(`Недопустимый путь: ${input}`);
    // eslint-disable-next-line no-control-regex
    if (/[\u0000-\u001f]/.test(p)) throw new Error('Недопустимые символы в пути');
  }
  const out = parts.join('/');
  if (!out) throw new Error('Пустой путь');
  if (out.length > MAX_PATH) throw new Error('Слишком длинный путь');
  return out;
}

/** Путь, доступный инструментам агента и пользователю (служебные каталоги закрыты). */
export function normalizeUserPath(input: string): string {
  const p = normalizePath(input);
  const top = p.split('/')[0] ?? '';
  if (RESERVED_PREFIXES.includes(top)) throw new Error(`Каталог «${top}» служебный`);
  return p;
}
