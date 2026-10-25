import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { normalizePath, type FileEntry, type FileStore } from './types.js';

/** Файловое хранилище на диске — для локальной разработки без Supabase. */
export class LocalFileStore implements FileStore {
  private readonly root: string;

  constructor(root: string) {
    this.root = path.resolve(root);
  }

  private resolve(p: string): string {
    const full = path.resolve(this.root, normalizePath(p));
    if (full !== this.root && !full.startsWith(this.root + path.sep)) throw new Error('Путь вне хранилища');
    return full;
  }

  async write(p: string, data: Buffer | string): Promise<void> {
    const full = this.resolve(p);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, data);
  }

  async read(p: string): Promise<Buffer | null> {
    try {
      return await readFile(this.resolve(p));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT' || (err as NodeJS.ErrnoException).code === 'EISDIR')
        return null;
      throw err;
    }
  }

  async exists(p: string): Promise<boolean> {
    try {
      return (await stat(this.resolve(p))).isFile();
    } catch {
      return false;
    }
  }

  async list(prefix = ''): Promise<FileEntry[]> {
    const rel = prefix ? normalizePath(prefix) : '';
    const dir = rel ? this.resolve(rel) : this.root;
    let names;
    try {
      names = await readdir(dir, { withFileTypes: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }
    const out: FileEntry[] = [];
    for (const d of names) {
      const full = path.join(dir, d.name);
      const s = await stat(full);
      out.push({
        path: rel ? `${rel}/${d.name}` : d.name,
        name: d.name,
        size: d.isDirectory() ? 0 : s.size,
        updatedAt: s.mtime.toISOString(),
        isDir: d.isDirectory(),
      });
    }
    return out.sort((a, b) => Number(b.isDir) - Number(a.isDir) || a.name.localeCompare(b.name));
  }

  async remove(p: string): Promise<void> {
    await rm(this.resolve(p), { force: true });
  }

  async move(from: string, to: string): Promise<void> {
    const dest = this.resolve(to);
    await mkdir(path.dirname(dest), { recursive: true });
    await rename(this.resolve(from), dest);
  }
}
