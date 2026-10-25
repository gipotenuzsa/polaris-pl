import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { normalizePath, type FileEntry, type FileStore } from './types.js';

/** Supabase Storage (приватный бакет). Ключ service_role остаётся только на сервере. */
export class SupabaseFileStore implements FileStore {
  private readonly client: SupabaseClient;
  private ready: Promise<void> | null = null;

  constructor(
    url: string,
    serviceKey: string,
    private readonly bucket: string,
  ) {
    this.client = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
  }

  private ensureBucket(): Promise<void> {
    this.ready ??= (async () => {
      const { data } = await this.client.storage.getBucket(this.bucket);
      if (data) return;
      const { error } = await this.client.storage.createBucket(this.bucket, { public: false });
      if (error && !/already exists|duplicate/i.test(error.message))
        throw new Error(`Supabase Storage: ${error.message}`);
    })().catch((err) => {
      this.ready = null;
      throw err;
    });
    return this.ready;
  }

  async write(p: string, data: Buffer | string, contentType = 'application/octet-stream'): Promise<void> {
    await this.ensureBucket();
    const body = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
    const { error } = await this.client.storage
      .from(this.bucket)
      .upload(normalizePath(p), body, { upsert: true, contentType });
    if (error) throw new Error(`Supabase Storage: ${error.message}`);
  }

  async read(p: string): Promise<Buffer | null> {
    await this.ensureBucket();
    const { data, error } = await this.client.storage.from(this.bucket).download(normalizePath(p));
    if (error || !data) return null;
    return Buffer.from(await data.arrayBuffer());
  }

  async exists(p: string): Promise<boolean> {
    const norm = normalizePath(p);
    const idx = norm.lastIndexOf('/');
    const dir = idx === -1 ? '' : norm.slice(0, idx);
    const name = norm.slice(idx + 1);
    await this.ensureBucket();
    const { data, error } = await this.client.storage.from(this.bucket).list(dir, { search: name, limit: 100 });
    if (error) throw new Error(`Supabase Storage: ${error.message}`);
    return (data ?? []).some((f) => f.name === name && f.id !== null);
  }

  async list(prefix = ''): Promise<FileEntry[]> {
    await this.ensureBucket();
    const rel = prefix ? normalizePath(prefix) : '';
    const { data, error } = await this.client.storage
      .from(this.bucket)
      .list(rel, { limit: 1000, sortBy: { column: 'name', order: 'asc' } });
    if (error) throw new Error(`Supabase Storage: ${error.message}`);
    return (data ?? [])
      .filter((f) => f.name !== '.emptyFolderPlaceholder')
      .map((f) => ({
        path: rel ? `${rel}/${f.name}` : f.name,
        name: f.name,
        size: Number((f.metadata as { size?: number } | null)?.size ?? 0),
        updatedAt: f.updated_at ?? undefined,
        isDir: f.id === null,
      }))
      .sort((a, b) => Number(b.isDir) - Number(a.isDir) || a.name.localeCompare(b.name));
  }

  async remove(p: string): Promise<void> {
    await this.ensureBucket();
    const { error } = await this.client.storage.from(this.bucket).remove([normalizePath(p)]);
    if (error) throw new Error(`Supabase Storage: ${error.message}`);
  }

  async move(from: string, to: string): Promise<void> {
    await this.ensureBucket();
    const { error } = await this.client.storage.from(this.bucket).move(normalizePath(from), normalizePath(to));
    if (error) throw new Error(`Supabase Storage: ${error.message}`);
  }
}
