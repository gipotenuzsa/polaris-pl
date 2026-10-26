// Собирает веб-версию клиента (PWA) и кладёт её в server/public — сервер раздаёт её со своего адреса.
//   node scripts/build-web.mjs            — экспорт Expo + копирование
//   node scripts/build-web.mjs --skip-export — только постобработка и копирование готового client/dist
import { execSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const clientDir = path.join(root, 'client');
const dist = path.join(clientDir, 'dist');
const targets = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const outDir = path.resolve(targets[0] ?? path.join(root, 'server', 'public'));

if (!process.argv.includes('--skip-export')) {
  execSync('npx expo export --platform web --output-dir dist', {
    cwd: clientDir,
    stdio: 'inherit',
    env: { ...process.env, NODE_ENV: 'production', CI: '1' },
  });
}

const indexPath = path.join(dist, 'index.html');
if (!existsSync(indexPath)) throw new Error('client/dist/index.html не найден — экспорт не удался');

// Expo в режиме output=single не использует +html.tsx, поэтому PWA-теги добавляем здесь.
let html = readFileSync(indexPath, 'utf8');
if (!html.includes('rel="manifest"')) {
  html = html
    .replace('<html lang="en">', '<html lang="ru">')
    .replace(
      /<meta name="viewport"[^>]*>/,
      '<meta name="viewport" content="width=device-width, initial-scale=1, shrink-to-fit=no, viewport-fit=cover" />',
    )
    .replace(
      '</head>',
      [
        '<link rel="manifest" href="/manifest.webmanifest">',
        '<link rel="apple-touch-icon" href="/apple-touch-icon.png">',
        '<meta name="apple-mobile-web-app-capable" content="yes">',
        '<meta name="mobile-web-app-capable" content="yes">',
        '<meta name="apple-mobile-web-app-title" content="Polaris">',
        '<meta name="apple-mobile-web-app-status-bar-style" content="default">',
        '<meta name="color-scheme" content="light">',
        '<style>html,body{background:#F5F0E6}</style>',
        '</head>',
      ].join('\n'),
    );
  writeFileSync(indexPath, html);
}

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });
cpSync(dist, outDir, { recursive: true });
console.log(`Веб-клиент скопирован: ${path.relative(root, outDir) || outDir}`);
