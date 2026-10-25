import { z } from 'zod';
import type { Browser, Page } from 'playwright-core';
import type { Config } from '../config.js';
import type { Logger } from '../util/logger.js';
import { assertPublicUrl } from './ssrf.js';
import { wrapUntrusted } from './web.js';
import { defineTool, type AnyTool } from './types.js';

const IDLE_CLOSE_MS = 60_000;
const BLOCKED_RESOURCES = new Set(['image', 'media', 'font']);

/**
 * Headless Chromium через Playwright — по запросу, по одной странице за раз, с таймаутами.
 * Режимы: локальный Chromium (BROWSER_EXECUTABLE_PATH / установленный Playwright) либо внешний сервис
 * по CDP (BROWSER_WS_ENDPOINT) — второй вариант для бесплатного Render с 512 МБ памяти.
 */
export class BrowserService {
  private browser: Browser | null = null;
  private idleTimer: NodeJS.Timeout | null = null;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly cfg: Pick<Config, 'browser' | 'allowPrivateNetwork'>,
    private readonly log: Logger,
  ) {}

  private async getBrowser(): Promise<Browser> {
    if (this.browser?.isConnected()) return this.browser;
    let pw: typeof import('playwright-core');
    try {
      pw = await import('playwright-core');
    } catch {
      throw new Error('Пакет playwright-core не установлен — браузер недоступен');
    }
    const { wsEndpoint, executablePath, maxMemoryMb } = this.cfg.browser;
    if (wsEndpoint) {
      this.browser = await pw.chromium.connectOverCDP(wsEndpoint, { timeout: 20_000 });
    } else {
      this.browser = await pw.chromium.launch({
        headless: true,
        executablePath,
        timeout: 30_000,
        args: [
          '--no-sandbox',
          '--disable-dev-shm-usage',
          '--disable-gpu',
          '--disable-extensions',
          '--disable-background-networking',
          '--mute-audio',
          '--renderer-process-limit=1',
          `--js-flags=--max-old-space-size=${maxMemoryMb}`,
        ],
      });
    }
    this.browser.on('disconnected', () => {
      this.browser = null;
    });
    return this.browser;
  }

  private scheduleIdleClose(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => void this.close(), IDLE_CLOSE_MS);
    this.idleTimer.unref();
  }

  /** Выполняет fn на чистой странице (отдельный контекст без cookie); вызовы идут строго по очереди. */
  run<T>(fn: (page: Page) => Promise<T>, timeoutMs = 45_000): Promise<T> {
    const task = async (): Promise<T> => {
      if (this.idleTimer) clearTimeout(this.idleTimer);
      const browser = await this.getBrowser();
      const context = await browser.newContext({
        viewport: { width: 1280, height: 800 },
        acceptDownloads: false,
        serviceWorkers: 'block',
        permissions: [],
      });
      try {
        await context.route('**/*', async (route) => {
          const req = route.request();
          const url = req.url();
          if (BLOCKED_RESOURCES.has(req.resourceType())) return route.abort();
          if (/^(data|blob|about):/.test(url)) return route.continue();
          try {
            await assertPublicUrl(url, { allowPrivate: this.cfg.allowPrivateNetwork });
          } catch {
            return route.abort('blockedbyclient');
          }
          return route.continue();
        });
        const page = await context.newPage();
        page.setDefaultTimeout(15_000);
        page.setDefaultNavigationTimeout(20_000);
        return await Promise.race([
          fn(page),
          new Promise<never>((_, reject) => {
            const t = setTimeout(() => reject(new Error('Таймаут операции браузера')), timeoutMs);
            t.unref();
          }),
        ]);
      } finally {
        await context
          .close()
          .catch((err: unknown) => this.log.warn({ err: String(err) }, 'Не удалось закрыть контекст браузера'));
        this.scheduleIdleClose();
      }
    };
    const next = this.queue.then(task, task);
    this.queue = next.catch(() => undefined);
    return next;
  }

  async close(): Promise<void> {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    const b = this.browser;
    this.browser = null;
    await b?.close().catch(() => undefined);
  }
}

async function snapshot(page: Page, selector: string | undefined, maxChars: number): Promise<string> {
  await page.waitForLoadState('networkidle', { timeout: 5_000 }).catch(() => undefined);
  const title = await page.title().catch(() => '');
  const text = (await page.innerText(selector ?? 'body').catch(() => '')).replace(/\n{3,}/g, '\n\n').trim();
  const links = (await page
    .evaluate(
      "Array.from(document.querySelectorAll('a[href]')).slice(0, 60).map(a => ({ text: (a.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 80), href: a.href })).filter(l => l.text && /^https?:/.test(l.href))",
    )
    .catch(() => [])) as { text: string; href: string }[];
  const clipped = text.length > maxChars;
  const parts = [
    `${title ? `Заголовок: ${title}\n` : ''}URL: ${page.url()}`,
    '',
    clipped ? text.slice(0, maxChars) : text,
  ];
  if (clipped) parts.push('', '[текст обрезан]');
  if (links.length) parts.push('', 'Ссылки:', ...links.slice(0, 15).map((l) => `- ${l.text}: ${l.href}`));
  return wrapUntrusted(page.url(), parts.join('\n'));
}

const stepSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('click'), selector: z.string().min(1) }),
  z.object({ action: z.literal('type'), selector: z.string().min(1), text: z.string().max(2000) }),
  z.object({ action: z.literal('press'), key: z.string().min(1).max(30) }),
  z.object({ action: z.literal('wait'), ms: z.number().int().min(100).max(10_000) }),
]);

export function browserTools(browser: BrowserService, allowPrivate: boolean): AnyTool[] {
  return [
    defineTool({
      name: 'browser_read',
      description:
        'Открывает страницу в headless-браузере (с выполнением JavaScript) и возвращает видимый текст. ' +
        'Для обычных страниц быстрее и дешевле read_url; браузер нужен для сайтов, которые рисуются скриптами.',
      schema: z.object({
        url: z.string().url(),
        selector: z.string().max(200).optional().describe('CSS-селектор области, по умолчанию вся страница'),
        maxChars: z.number().int().min(500).max(30_000).optional(),
      }),
      timeoutMs: 60_000,
      describe: (a) => `Браузер: открыть ${a.url}`,
      async execute(a) {
        await assertPublicUrl(a.url, { allowPrivate });
        const content = await browser.run(async (page) => {
          await page.goto(a.url, { waitUntil: 'domcontentloaded' });
          return snapshot(page, a.selector, a.maxChars ?? 12_000);
        });
        return { content, summary: `Браузер: прочитано ${a.url}` };
      },
    }),
    defineTool({
      name: 'browser_act',
      description:
        'Открывает страницу и выполняет действия: click, type, press, wait. Может изменить данные на внешнем сайте, ' +
        'поэтому всегда требует подтверждения пользователя.',
      schema: z.object({
        url: z.string().url(),
        steps: z.array(stepSchema).min(1).max(15),
        maxChars: z.number().int().min(500).max(30_000).optional(),
      }),
      timeoutMs: 90_000,
      approval: (a) => `Действия в браузере на ${new URL(a.url).hostname}: ${a.steps.map((s) => s.action).join(', ')}`,
      describe: (a) => `Браузер: ${a.steps.length} действий на ${a.url}`,
      async execute(a) {
        await assertPublicUrl(a.url, { allowPrivate });
        const content = await browser.run(async (page) => {
          await page.goto(a.url, { waitUntil: 'domcontentloaded' });
          for (const s of a.steps) {
            if (s.action === 'click') await page.click(s.selector);
            else if (s.action === 'type') await page.fill(s.selector, s.text);
            else if (s.action === 'press') await page.keyboard.press(s.key);
            else await page.waitForTimeout(s.ms);
          }
          return snapshot(page, undefined, a.maxChars ?? 12_000);
        }, 80_000);
        return { content, summary: `Браузер: выполнено ${a.steps.length} действий на ${a.url}` };
      },
    }),
  ];
}
