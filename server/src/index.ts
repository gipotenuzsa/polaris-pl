import { pino } from 'pino';
import { buildApp } from './app.js';
import { createContext } from './bootstrap.js';
import { loadConfig } from './config.js';
import { startSelfPing } from './util/keepalive.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = pino({
    level: config.logLevel,
    redact: ['req.headers.authorization', 'req.headers.cookie', 'res.headers["set-cookie"]'],
  });

  const ctx = await createContext({ config, log: logger });
  const app = await buildApp(ctx, { logger });
  await ctx.scheduler.start();
  const stopPing = startSelfPing({ publicUrl: config.publicUrl, enabled: config.selfPing, log: logger });
  await app.listen({ port: config.port, host: config.host });
  logger.info({ port: config.port, tools: ctx.tools.all().map((t) => t.name) }, 'Polaris запущен');

  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    logger.info({ signal }, 'Останавливаюсь…');
    ctx.scheduler.stop();
    stopPing?.();
    await Promise.race([ctx.runs.idle(), new Promise((r) => setTimeout(r, 10_000))]);
    await app.close();
    await ctx.db.close();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err: unknown) => {
  console.error('Не удалось запустить Polaris:', err instanceof Error ? err.message : err);
  process.exit(1);
});
