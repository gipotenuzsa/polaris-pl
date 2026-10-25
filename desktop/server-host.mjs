// Запускает сервер Polaris внутри процесса Electron. Сервер — тот же код, что и на Render (server/dist).
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * @param {{ contentDir: string, logFile: string, env: Record<string, string> }} opts
 * @returns {Promise<{ port: number, stop: () => Promise<void>, toolNames: string[] }>}
 */
export async function startServer({ contentDir, logFile, env }) {
  Object.assign(process.env, env);
  const serverDir = path.join(contentDir, 'server');
  const load = (file) => import(pathToFileURL(path.join(serverDir, 'dist', file)).href);
  const require = createRequire(path.join(serverDir, 'package.json'));
  const { pino } = require('pino');

  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  const logger = pino(
    { level: process.env.LOG_LEVEL || 'info', redact: ['req.headers.authorization', 'req.headers.cookie'] },
    pino.destination({ dest: logFile, sync: false }),
  );

  const { loadConfig } = await load('config.js');
  const { createContext } = await load('bootstrap.js');
  const { buildApp } = await load('app.js');

  const config = loadConfig(process.env);
  const ctx = await createContext({ config, log: logger });
  const app = await buildApp(ctx, { logger });
  await ctx.scheduler.start();
  await app.listen({ port: config.port, host: '127.0.0.1' });
  logger.info({ port: config.port }, 'Polaris (desktop) запущен');

  return {
    port: config.port,
    toolNames: ctx.tools.all().map((t) => t.name),
    async stop() {
      ctx.scheduler.stop();
      await Promise.race([ctx.runs.idle(), new Promise((r) => setTimeout(r, 8000))]);
      await app.close();
      await ctx.db.close();
      logger.flush?.();
    },
  };
}
