import net from 'node:net';
import webpush from 'web-push';
import type { AppContext } from '../context.js';
import { decryptSecret, encryptSecret } from '../crypto/secrets.js';
import { queryOne } from '../db/types.js';
import { badRequest } from '../util/errors.js';
import { isPrivateIp } from '../tools/ssrf.js';

export interface PushPayload {
  title: string;
  body: string;
  /** Путь внутри приложения, который откроется по нажатию на уведомление. */
  url: string;
  /** Уведомления с одинаковым tag заменяют друг друга. */
  tag?: string;
  urgent?: boolean;
  /** Подтверждение, которое можно одобрить/отклонить кнопками прямо в уведомлении. */
  approvalId?: string;
}

export interface PushSubscriptionInput {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

export interface SendOptions {
  vapidDetails: { subject: string; publicKey: string; privateKey: string };
  TTL: number;
  urgency: 'normal' | 'high';
  timeout: number;
}

export type PushSender = (sub: PushSubscriptionInput, payload: string, options: SendOptions) => Promise<unknown>;

const defaultSender: PushSender = (sub, payload, options) => webpush.sendNotification(sub, payload, options);

interface StoredVapid {
  publicKey: string;
  privateKeyEnc: string;
}

export interface SendResult {
  sent: number;
  removed: number;
  failed: number;
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** Куда вести по нажатию на уведомление. */
export function urlForNotification(kind: string, ref?: { conversationId?: string; taskId?: string }): string {
  if (kind === 'approval') return '/approvals';
  if (ref?.conversationId) return `/chat/${ref.conversationId}`;
  if (ref?.taskId) return `/task/${ref.taskId}`;
  return '/inbox';
}

/**
 * Web Push для PWA (iPhone с iOS 16.4+ при установке на экран «Домой», Android, десктопные браузеры).
 * Ключи VAPID создаются при первом обращении и хранятся в БД (закрытый — в зашифрованном виде).
 */
export class PushService {
  private vapidCache: { publicKey: string; privateKey: string } | null = null;

  constructor(
    private readonly ctx: AppContext,
    private readonly sender: PushSender = defaultSender,
  ) {}

  private async vapid(): Promise<{ publicKey: string; privateKey: string }> {
    if (this.vapidCache) return this.vapidCache;
    const key = this.ctx.config.encryptionKey;
    const read = async () => {
      const row = await queryOne<{ value: StoredVapid }>(
        this.ctx.db,
        `select value from settings where key = 'webpush'`,
      );
      return row?.value;
    };
    let stored = await read();
    if (!stored) {
      const fresh = webpush.generateVAPIDKeys();
      await this.ctx.db.query(
        `insert into settings (key, value) values ('webpush', $1::jsonb) on conflict (key) do nothing`,
        [JSON.stringify({ publicKey: fresh.publicKey, privateKeyEnc: encryptSecret(fresh.privateKey, key) })],
      );
      stored = await read(); // при гонке победит первая запись
    }
    if (!stored) throw new Error('Не удалось создать ключи VAPID');
    this.vapidCache = { publicKey: stored.publicKey, privateKey: decryptSecret(stored.privateKeyEnc, key) };
    return this.vapidCache;
  }

  async publicKey(): Promise<string> {
    return (await this.vapid()).publicKey;
  }

  private subject(): string {
    const { vapidSubject, publicUrl } = this.ctx.config;
    if (vapidSubject) return vapidSubject;
    if (publicUrl?.startsWith('https://')) return publicUrl;
    return 'mailto:polaris@example.com';
  }

  /** Эндпоинт должен быть https и не вести во внутреннюю сеть: сервер сам делает на него запросы. */
  private assertEndpoint(endpoint: string): void {
    let url: URL;
    try {
      url = new URL(endpoint);
    } catch {
      throw badRequest('Некорректный адрес подписки');
    }
    const host = url.hostname.replace(/^\[|\]$/g, '');
    if (url.protocol !== 'https:') throw badRequest('Адрес подписки должен быть https');
    if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal'))
      throw badRequest('Недопустимый адрес подписки');
    if (net.isIP(host) && isPrivateIp(host)) throw badRequest('Недопустимый адрес подписки');
  }

  async subscribe(sub: PushSubscriptionInput, userAgent?: string): Promise<void> {
    this.assertEndpoint(sub.endpoint);
    await this.ctx.db.query(
      `insert into push_subscriptions (endpoint, p256dh, auth, user_agent) values ($1, $2, $3, $4)
       on conflict (endpoint) do update set p256dh = excluded.p256dh, auth = excluded.auth,
         user_agent = excluded.user_agent, failures = 0`,
      [sub.endpoint, sub.keys.p256dh, sub.keys.auth, (userAgent ?? '').slice(0, 200)],
    );
  }

  async unsubscribe(endpoint: string): Promise<void> {
    await this.ctx.db.query('delete from push_subscriptions where endpoint = $1', [endpoint]);
  }

  async count(): Promise<number> {
    const row = await queryOne<{ n: number }>(this.ctx.db, 'select count(*)::int as n from push_subscriptions');
    return row?.n ?? 0;
  }

  async send(payload: PushPayload): Promise<SendResult> {
    const subs = await this.ctx.db.query<{
      id: string;
      endpoint: string;
      p256dh: string;
      auth: string;
      failures: number;
    }>('select id, endpoint, p256dh, auth, failures from push_subscriptions');
    const result: SendResult = { sent: 0, removed: 0, failed: 0 };
    if (subs.length === 0) return result;

    const { publicKey, privateKey } = await this.vapid();
    const body = JSON.stringify({
      title: clip(payload.title, 80),
      body: clip(payload.body, 200),
      url: payload.url,
      tag: payload.tag,
      approvalId: payload.approvalId,
    });
    const options: SendOptions = {
      vapidDetails: { subject: this.subject(), publicKey, privateKey },
      TTL: 6 * 3600,
      urgency: payload.urgent ? 'high' : 'normal',
      timeout: 10_000,
    };

    await Promise.all(
      subs.map(async (s) => {
        try {
          await this.sender({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, body, options);
          result.sent++;
          await this.ctx.db.query('update push_subscriptions set failures = 0, last_ok_at = now() where id = $1', [
            s.id,
          ]);
        } catch (err) {
          const status = (err as { statusCode?: number }).statusCode;
          if (status === 404 || status === 410) {
            // подписка отозвана (приложение удалено или уведомления выключены)
            await this.ctx.db.query('delete from push_subscriptions where id = $1', [s.id]);
            result.removed++;
          } else {
            result.failed++;
            this.ctx.log.warn({ status, err: String((err as Error).message).slice(0, 200) }, 'Web Push не доставлен');
            // подписки, которые подряд 10 раз не доставились, считаем мёртвыми
            await this.ctx.db.query(
              `with u as (update push_subscriptions set failures = failures + 1 where id = $1 returning id, failures)
               delete from push_subscriptions where id in (select id from u where failures >= 10)`,
              [s.id],
            );
          }
        }
      }),
    );
    return result;
  }

  /** Отправка «в фоне»: ошибки только логируются, вызывающий код не ждёт. */
  notify(payload: PushPayload): void {
    void this.send(payload).catch((err: unknown) => this.ctx.log.warn({ err: String(err) }, 'Web Push: сбой отправки'));
  }
}
