import type { AppContext } from '../context.js';
import type { Db } from '../db/types.js';
import { conflict } from '../util/errors.js';

/** Keeps destructive changes separate from API writes and background work. */
export class DataService {
  private readonly writes = new Set<string>();
  deleting = false;

  constructor(private readonly ctx: AppContext) {}

  enterRequest(id: string, writing: boolean): void {
    if (this.deleting) throw conflict('Данные очищаются. Подождите немного.', 'data_busy');
    if (writing) this.writes.add(id);
  }

  leaveRequest(id: string): void {
    this.writes.delete(id);
  }

  async exclusive<T>(action: () => Promise<T>): Promise<T> {
    if (
      this.deleting ||
      this.writes.size > 1 ||
      this.ctx.runs.activeCount() > 0 ||
      this.ctx.scheduler.isTicking ||
      this.ctx.compaction.isRunning() ||
      this.ctx.checkins.isRunning ||
      this.ctx.tasks.isExecuting ||
      this.ctx.morning.isPreparing ||
      this.ctx.push.isSending
    ) {
      throw conflict(
        'Дождитесь завершения текущих задач и ответов или остановите их, затем повторите удаление.',
        'data_busy',
      );
    }
    this.deleting = true;
    try {
      return await action();
    } finally {
      this.deleting = false;
    }
  }

  /** Remove references too: approval payloads and undo records can contain the conversation. */
  async removeConversations(tx: Db, ids: string[]): Promise<void> {
    if (!ids.length) return;
    await tx.query(
      `delete from notifications where ref->>'conversationId' = any($1::text[])
        or ref->>'approvalId' in (select id::text from approvals where conversation_id = any($1::uuid[]))`,
      [ids],
    );
    await tx.query('delete from actions_log where conversation_id = any($1::uuid[])', [ids]);
    await tx.query('delete from approvals where conversation_id = any($1::uuid[])', [ids]);
    await tx.query('delete from usage_log where conversation_id = any($1::uuid[])', [ids]);
    await tx.query('delete from conversations where id = any($1::uuid[])', [ids]);
  }

  async clearChats(): Promise<void> {
    await this.exclusive(() =>
      this.ctx.db.transaction(async (tx) => {
        const chats = await tx.query<{ id: string }>("select id from conversations where kind in ('chat', 'summary')");
        await this.removeConversations(
          tx,
          chats.map((c) => c.id),
        );
        await tx.query('delete from attachments where message_id is null');
      }),
    );
  }

  private async clearFiles(prefix = ''): Promise<void> {
    for (const entry of await this.ctx.files.list(prefix)) {
      if (entry.isDir) await this.clearFiles(entry.path);
      else await this.ctx.files.remove(entry.path);
    }
  }

  async clearAll(): Promise<void> {
    await this.exclusive(async () => {
      // Storage is external to the DB transaction. On a storage error the DB stays intact,
      // and repeating the operation finishes removing any remaining files.
      await this.clearFiles();
      await this.ctx.db.transaction(async (tx) => {
        for (const table of [
          'notifications',
          'actions_log',
          'approvals',
          'usage_log',
          'task_steps',
          'tasks',
          'attachments',
          'messages',
          'conversations',
          'memory',
          'notes',
          'reminders',
          'oauth_flows',
          'provider_credentials',
          'push_subscriptions',
          'settings',
          'sessions',
        ]) {
          await tx.query(`delete from ${table}`);
        }
      });
      this.ctx.push.clearCache();
    });
  }
}
