import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { parse } from '../auth/auth.js';
import type { AppContext } from '../context.js';

export function backupRoutes(app: FastifyInstance, ctx: AppContext): void {
  /** Резервная копия всех данных одним JSON-файлом. */
  app.get('/api/backup', async (_req, reply) => {
    const file = await ctx.backup.export();
    const stamp = file.createdAt.slice(0, 10);
    return reply
      .header('content-type', 'application/json; charset=utf-8')
      .header('content-disposition', `attachment; filename="polaris-backup-${stamp}.json"`)
      .header('cache-control', 'no-store')
      .send(JSON.stringify(file));
  });

  /** Восстановление: ЗАМЕНЯЕТ данные этого сервера данными из копии. Нужно явное подтверждение replace: true. */
  app.post('/api/backup/restore', { bodyLimit: 150_000_000 }, async (req) => {
    const b = parse(z.object({ replace: z.literal(true), backup: z.unknown() }), req.body);
    const counts = await ctx.backup.restore(b.backup);
    ctx.log.info({ counts }, 'Данные восстановлены из резервной копии');
    return { ok: true, counts };
  });
}
