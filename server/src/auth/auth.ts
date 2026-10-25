import bcrypt from 'bcryptjs';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { randomToken, sha256Hex } from '../crypto/secrets.js';
import { queryOne } from '../db/types.js';
import { badRequest, HttpError, unauthorized } from '../util/errors.js';

export const COOKIE_NAME = 'polaris_session';
const UNSAFE = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** Хэш пароля инстанса: из POLARIS_PASSWORD_HASH, либо (только вне production) из POLARIS_PASSWORD. */
export function resolvePasswordHash(config: AppContext['config']): string | undefined {
  if (config.passwordHash) return config.passwordHash;
  if (config.plainPassword) return bcrypt.hashSync(config.plainPassword, 10);
  return undefined;
}

function extractToken(req: FastifyRequest): { token: string; viaCookie: boolean } | null {
  const header = req.headers.authorization;
  if (header?.toLowerCase().startsWith('bearer ')) return { token: header.slice(7).trim(), viaCookie: false };
  const cookie = req.cookies[COOKIE_NAME];
  return cookie ? { token: cookie, viaCookie: true } : null;
}

/** Защита от CSRF для cookie-сессий: если браузер прислал Origin, он должен совпадать с хостом запроса. */
function checkOrigin(req: FastifyRequest, publicUrl?: string): void {
  const origin = req.headers.origin;
  if (!origin) return;
  let originHost: string;
  try {
    originHost = new URL(origin).host;
  } catch {
    throw new HttpError(403, 'Недопустимый Origin', 'forbidden');
  }
  const norm = (h: string) => h.toLowerCase().replace(/:(80|443)$/, '');
  const allowed = new Set(
    [
      req.headers.host,
      req.headers['x-forwarded-host'] as string | undefined,
      publicUrl ? new URL(publicUrl).host : undefined,
    ]
      .filter((h): h is string => Boolean(h))
      .map(norm),
  );
  if (!allowed.has(norm(originHost))) throw new HttpError(403, 'Запрос с чужого источника отклонён', 'forbidden');
}

export function registerAuth(app: FastifyInstance, ctx: AppContext): void {
  const passwordHash = resolvePasswordHash(ctx.config);
  if (!passwordHash) {
    ctx.log.warn(
      {},
      'Пароль инстанса не задан (POLARIS_PASSWORD_HASH): вход невозможен. Сгенерируйте хэш: npm run hash-password -- "пароль"',
    );
  }

  const ttlMs = ctx.config.sessionTtlDays * 86_400_000;

  async function findSession(token: string) {
    return queryOne<{ id: string }>(ctx.db, 'select id from sessions where token_hash = $1 and expires_at > now()', [
      sha256Hex(token),
    ]);
  }

  app.addHook('preHandler', async (req: FastifyRequest) => {
    const url = req.url.split('?')[0] ?? '';
    if (!url.startsWith('/api/')) return;
    if (url === '/api/auth/login' || url === '/api/auth/session') return;

    const found = extractToken(req);
    if (!found) throw unauthorized();
    const session = await findSession(found.token);
    if (!session) throw unauthorized('Сессия истекла — войдите снова');
    if (found.viaCookie && UNSAFE.has(req.method)) checkOrigin(req, ctx.config.publicUrl);
    void ctx.db
      .query(`update sessions set last_seen_at = now() where id = $1 and last_seen_at < now() - interval '5 minutes'`, [
        session.id,
      ])
      .catch(() => undefined);
  });

  app.post(
    '/api/auth/login',
    { config: { rateLimit: { max: 8, timeWindow: '1 minute' } } },
    async (req: FastifyRequest, reply: FastifyReply) => {
      if (!passwordHash) throw new HttpError(503, 'Пароль инстанса не настроен на сервере', 'no_password');
      const { password } = z.object({ password: z.string().min(1).max(500) }).parse(req.body ?? {});
      const ok = await bcrypt.compare(password, passwordHash);
      if (!ok) {
        await new Promise((r) => setTimeout(r, 400)); // замедляем подбор
        throw unauthorized('Неверный пароль');
      }
      await ctx.db.query('delete from sessions where expires_at < now()');
      const token = randomToken(32);
      // срок считаем по времени БД — той же меткой, по которой сессия проверяется
      await ctx.db.query(
        `insert into sessions (token_hash, user_agent, expires_at) values ($1, $2, now() + make_interval(secs => $3::float8))`,
        [sha256Hex(token), String(req.headers['user-agent'] ?? '').slice(0, 200), ttlMs / 1000],
      );
      reply.setCookie(COOKIE_NAME, token, {
        httpOnly: true,
        sameSite: 'strict',
        secure: ctx.config.cookieSecure,
        path: '/',
        maxAge: Math.floor(ttlMs / 1000),
      });
      // token в теле нужен нативному клиенту (Bearer); браузеру достаточно httpOnly-cookie
      return { ok: true, token };
    },
  );

  app.post('/api/auth/logout', async (req: FastifyRequest, reply: FastifyReply) => {
    const found = extractToken(req);
    if (found) await ctx.db.query('delete from sessions where token_hash = $1', [sha256Hex(found.token)]);
    reply.clearCookie(COOKIE_NAME, { path: '/' });
    return { ok: true };
  });

  app.get('/api/auth/session', async (req: FastifyRequest) => {
    const found = extractToken(req);
    const session = found ? await findSession(found.token) : undefined;
    return { authenticated: Boolean(session), loginAvailable: Boolean(passwordHash) };
  });
}

export function parse<S extends z.ZodType>(schema: S, data: unknown): z.infer<S> {
  const r = schema.safeParse(data);
  if (!r.success) throw badRequest(r.error.issues.map((i) => `${i.path.join('.') || 'тело'}: ${i.message}`).join('; '));
  return r.data;
}
