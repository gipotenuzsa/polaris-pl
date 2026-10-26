// Polaris для Windows: окно Electron + локальный сервер Polaris в одном процессе.
// Режимы: «локальный» (по умолчанию: сервер, база и файлы на этом ПК) и «удалённый» (окно-клиент к серверу на Render).
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, session, shell } from 'electron';
import { startServer } from './server-host.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const contentDir = app.isPackaged ? path.join(process.resourcesPath, 'app-content') : path.join(here, 'app');
const userData = app.getPath('userData');
const envFile = path.join(userData, 'polaris.env');
const stateFile = path.join(userData, 'desktop.json');
const logFile = path.join(userData, 'logs', 'server.log');
const iconPath = path.join(here, 'build', 'icon.png');

/** @type {BrowserWindow | null} */
let win = null;
/** @type {{ port: number, stop: () => Promise<void> } | null} */
let server = null;
let localPassword = '';
let quitting = false;

// ── Настройки ──────────────────────────────────────────────────────────────────

const ENV_TEMPLATE = `# Настройки Polaris для Windows. Строки вида КЛЮЧ=значение; «#» — комментарий.
# После изменений: меню «Сервер → Перезапустить сервер».
#
# Модели: только ChatGPT по OAuth. Войдите в приложении: Ещё → Настройки → ChatGPT.

# Поиск в интернете встроен в ChatGPT и работает в рамках вашей подписки; отключить: CHATGPT_WEB_SEARCH=false

# Браузер для агента (Playwright + установленный Edge/Chrome). Включайте при необходимости.
BROWSER_ENABLED=false
BROWSER_EXECUTABLE_PATH=C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe

# Часовой пояс для расписаний, напоминаний и утренней сводки
INSTANCE_TIMEZONE=@TZ@

# Порт локального сервера (если занят, будет выбран свободный)
PORT=8787

# Лимиты бюджета по умолчанию (меняются и в приложении: Ещё → Настройки)
BUDGET_DAILY_TOKENS=500000
BUDGET_DAILY_USD=2
BUDGET_RUN_TOKENS=100000
BUDGET_RUN_USD=0.5

# ── Служебное (создано автоматически, не меняйте) ──
`;

function parseEnv(text) {
  const out = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const i = line.indexOf('=');
    if (i < 1) continue;
    let value = line.slice(i + 1).trim();
    if (/^(["']).*\1$/.test(value)) value = value.slice(1, -1);
    out[line.slice(0, i).trim()] = value;
  }
  return out;
}

function ensureEnvFile() {
  fs.mkdirSync(userData, { recursive: true });
  if (!fs.existsSync(envFile)) {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
    fs.writeFileSync(envFile, ENV_TEMPLATE.replace('@TZ@', tz), 'utf8');
  }
  let text = fs.readFileSync(envFile, 'utf8');
  let values = parseEnv(text);
  const append = (key, value) => {
    text += `${text.endsWith('\n') ? '' : '\n'}${key}=${value}\n`;
  };
  if (!values.ENCRYPTION_KEY) append('ENCRYPTION_KEY', randomBytes(32).toString('base64'));
  if (!values.POLARIS_PASSWORD) append('POLARIS_PASSWORD', randomBytes(18).toString('base64url'));
  fs.writeFileSync(envFile, text, 'utf8');
  values = parseEnv(text);
  return values;
}

function readState() {
  try {
    return JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  } catch {
    return { mode: 'local' };
  }
}

function writeState(state) {
  fs.mkdirSync(userData, { recursive: true });
  fs.writeFileSync(stateFile, JSON.stringify(state, null, 2), 'utf8');
}

/** Порт уже кем-то слушается? На Windows bind на 127.0.0.1 «перебивает» чужой 0.0.0.0, поэтому проверяем подключением. */
function portInUse(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host: '127.0.0.1' });
    socket.setTimeout(400);
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('timeout', () => {
      socket.destroy();
      resolve(false);
    });
    socket.once('error', () => resolve(false));
  });
}

async function freePort(preferred) {
  const tryListen = (port) =>
    new Promise((resolve) => {
      const s = net.createServer();
      s.once('error', () => resolve(null));
      s.listen(port, '127.0.0.1', () => {
        const actual = s.address().port;
        s.close(() => resolve(actual));
      });
    });
  if (!(await portInUse(preferred))) {
    const p = await tryListen(preferred);
    if (p) return p;
  }
  return (await tryListen(0)) ?? preferred;
}

// ── Сервер и окно ──────────────────────────────────────────────────────────────

const page = (title, body) =>
  'data:text/html;charset=utf-8,' +
  encodeURIComponent(`<!doctype html><meta charset="utf-8"><title>${title}</title>
  <body style="margin:0;display:flex;align-items:center;justify-content:center;height:100vh;background:#F5F0E6;color:#2B2620;font:15px 'Segoe UI',sans-serif">
  <div style="max-width:560px;padding:24px;text-align:center">${body}</div>`);

const loadingPage = page(
  'Polaris',
  '<div style="font-size:38px;color:#B8613A">✦</div><h2>Polaris запускается…</h2><p style="color:#8C8272">Поднимаю локальный сервер</p>',
);

async function startLocal() {
  const values = ensureEnvFile();
  const port = await freePort(Number(values.PORT) || 8787);
  const env = {
    ...values,
    NODE_ENV: 'desktop',
    HOST: '127.0.0.1',
    PORT: String(port),
    DATA_DIR: path.join(userData, 'data'),
    WEB_DIR: path.join(contentDir, 'web'),
    MIGRATIONS_DIR: path.join(contentDir, 'supabase', 'migrations'),
    LOCAL_FILES_DIR: path.join(userData, 'files'),
    SCHEDULER_ENABLED: 'true',
    LOG_LEVEL: values.LOG_LEVEL || 'info',
  };
  localPassword = values.POLARIS_PASSWORD;
  server = await startServer({ contentDir, logFile, env });
  return `http://127.0.0.1:${server.port}`;
}

/** Входит от имени владельца (пароль лежит в polaris.env) и кладёт сессионную cookie в окно. */
async function autoLogin(base) {
  const res = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: localPassword }),
  });
  if (!res.ok) throw new Error(`Автоматический вход не удался (HTTP ${res.status})`);
  const { token } = await res.json();
  await session.defaultSession.cookies.set({
    url: base,
    name: 'polaris_session',
    value: token,
    httpOnly: true,
    sameSite: 'strict',
    expirationDate: Math.floor(Date.now() / 1000) + 29 * 86400,
  });
}

async function stopLocal() {
  const s = server;
  server = null;
  if (s) await s.stop().catch(() => undefined);
}

async function openLocal() {
  win?.loadURL(loadingPage);
  try {
    const base = await startLocal();
    await autoLogin(base);
    await win?.loadURL(base);
  } catch (err) {
    await stopLocal();
    const message = String(err?.message ?? err).replace(/</g, '&lt;');
    await win?.loadURL(
      page(
        'Ошибка',
        `<h2 style="color:#B5483A">Не удалось запустить Polaris</h2><p>${message}</p>
         <p style="color:#8C8272">Журнал: ${logFile.replace(/\\/g, '\\\\')}<br>Настройки: ${envFile.replace(/\\/g, '\\\\')}</p>
         <p style="color:#8C8272">Исправьте настройки и выберите «Сервер → Перезапустить сервер».</p>`,
      ),
    );
  }
}

async function openRemote(url) {
  await stopLocal();
  await win?.loadURL(url).catch((err) => {
    dialog.showErrorBox('Не удалось открыть сервер', `${url}\n\n${err.message}`);
  });
}

async function start() {
  const state = readState();
  if (state.mode === 'remote' && state.remoteUrl) await openRemote(state.remoteUrl);
  else await openLocal();
}

function askRemoteUrl(current) {
  return new Promise((resolve) => {
    const dlg = new BrowserWindow({
      parent: win ?? undefined,
      modal: true,
      width: 540,
      height: 250,
      resizable: false,
      minimizable: false,
      maximizable: false,
      backgroundColor: '#F5F0E6',
      webPreferences: {
        preload: path.join(here, 'prompt-preload.cjs'),
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    dlg.removeMenu();
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      ipcMain.removeListener('prompt:result', onResult);
      resolve(value);
      if (!dlg.isDestroyed()) dlg.close();
    };
    const onResult = (_e, value) => finish(value);
    ipcMain.on('prompt:result', onResult);
    dlg.on('closed', () => finish(null));
    void dlg.loadFile(path.join(here, 'prompt.html'), { query: { value: current ?? '' } });
  });
}

function normalizeUrl(input) {
  let u = input.trim().replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(u)) u = `${/^(localhost|127\.|10\.|192\.168\.)/.test(u) ? 'http' : 'https'}://${u}`;
  try {
    return new URL(u).origin;
  } catch {
    return null;
  }
}

// ── Меню ───────────────────────────────────────────────────────────────────────

function buildMenu() {
  const template = [
    {
      label: 'Polaris',
      submenu: [
        { label: 'Перезагрузить окно', accelerator: 'CmdOrCtrl+R', click: () => win?.reload() },
        {
          label: 'Открыть в браузере',
          click: () => {
            const url = win?.webContents.getURL();
            if (url?.startsWith('http')) void shell.openExternal(url);
          },
        },
        { type: 'separator' },
        { label: 'Выход', accelerator: 'Alt+F4', click: () => app.quit() },
      ],
    },
    {
      label: 'Сервер',
      submenu: [
        { label: 'Файл настроек (ключи API)…', click: () => void shell.openPath(ensureEnvFilePath()) },
        { label: 'Папка с данными', click: () => void shell.openPath(userData) },
        { label: 'Журнал сервера', click: () => void shell.openPath(fs.existsSync(logFile) ? logFile : userData) },
        { type: 'separator' },
        {
          label: 'Перезапустить сервер',
          click: async () => {
            writeState({ mode: 'local' });
            await stopLocal();
            await openLocal();
          },
        },
        {
          label: 'Подключиться к удалённому серверу…',
          click: async () => {
            const input = await askRemoteUrl(readState().remoteUrl);
            if (!input) return;
            const url = normalizeUrl(input);
            if (!url) return void dialog.showErrorBox('Некорректный адрес', input);
            writeState({ mode: 'remote', remoteUrl: url });
            await openRemote(url);
          },
        },
        {
          label: 'Вернуться к локальному серверу',
          click: async () => {
            writeState({ mode: 'local' });
            await openLocal();
          },
        },
      ],
    },
    {
      label: 'Вид',
      submenu: [
        { label: 'Увеличить', accelerator: 'CmdOrCtrl+Plus', role: 'zoomIn' },
        { label: 'Уменьшить', accelerator: 'CmdOrCtrl+-', role: 'zoomOut' },
        { label: 'Масштаб 100%', accelerator: 'CmdOrCtrl+0', role: 'resetZoom' },
        { type: 'separator' },
        { label: 'На весь экран', role: 'togglefullscreen' },
        { label: 'Инструменты разработчика', accelerator: 'F12', role: 'toggleDevTools' },
      ],
    },
    {
      label: 'Справка',
      submenu: [
        {
          label: 'О программе',
          click: () =>
            void dialog.showMessageBox(win ?? undefined, {
              type: 'info',
              title: 'Polaris',
              message: `Polaris ${app.getVersion()}`,
              detail:
                'Открытый self-hosted фоновый AI-агент.\n' +
                `Режим: ${readState().mode === 'remote' ? 'удалённый сервер' : 'локальный сервер на этом компьютере'}\n` +
                `Данные: ${userData}`,
            }),
        },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function ensureEnvFilePath() {
  ensureEnvFile();
  return envFile;
}

// ── Жизненный цикл ─────────────────────────────────────────────────────────────

function createWindow() {
  win = new BrowserWindow({
    width: 1100,
    height: 820,
    minWidth: 420,
    minHeight: 560,
    backgroundColor: '#F5F0E6',
    title: 'Polaris',
    icon: fs.existsSync(iconPath) ? nativeImage.createFromPath(iconPath) : undefined,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  win.on('page-title-updated', (e) => e.preventDefault()); // заголовок окна всегда «Polaris»
  // Ссылки наружу (например, вход в ChatGPT) открываем в системном браузере, а не внутри окна
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    const current = win?.webContents.getURL() ?? '';
    if (url.startsWith('data:') || current.startsWith('data:')) return;
    try {
      if (new URL(url).origin !== new URL(current).origin) {
        event.preventDefault();
        if (/^https?:/i.test(url)) void shell.openExternal(url);
      }
    } catch {
      /* пропускаем */
    }
  });
  win.on('closed', () => {
    win = null;
  });
  void win.loadURL(loadingPage);
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  app.whenReady().then(async () => {
    buildMenu();
    createWindow();
    await start();
  });

  app.on('window-all-closed', () => app.quit());

  app.on('before-quit', (event) => {
    if (quitting || !server) return;
    event.preventDefault();
    quitting = true;
    void stopLocal().finally(() => app.quit());
  });
}
