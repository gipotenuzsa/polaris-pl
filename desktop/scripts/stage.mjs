// Готовит содержимое Windows-приложения в desktop/app:
//   web/                — веб-клиент (PWA)
//   server/dist + node_modules — скомпилированный сервер с production-зависимостями
//   supabase/migrations — SQL-миграции
// Использование: node scripts/stage.mjs [--skip-export] [--skip-server-build]
import { execSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const root = path.resolve(desktop, '..');
const out = path.join(desktop, 'app');
const flag = (name) => process.argv.includes(name);
const run = (cmd, cwd) => execSync(cmd, { cwd, stdio: 'inherit' });

console.log('▸ Сборка сервера');
if (!flag('--skip-server-build')) run('npm run build', path.join(root, 'server'));

console.log('▸ Сборка веб-клиента');
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
run(`node scripts/build-web.mjs "${path.join(out, 'web')}"${flag('--skip-export') ? ' --skip-export' : ''}`, root);

console.log('▸ Сервер и зависимости');
const serverOut = path.join(out, 'server');
mkdirSync(serverOut, { recursive: true });
cpSync(path.join(root, 'server', 'dist'), path.join(serverOut, 'dist'), { recursive: true });
for (const f of ['package.json', 'package-lock.json']) cpSync(path.join(root, 'server', f), path.join(serverOut, f));
run('npm ci --omit=dev --no-audit --no-fund', serverOut);

console.log('▸ Миграции');
cpSync(path.join(root, 'supabase', 'migrations'), path.join(out, 'supabase', 'migrations'), { recursive: true });

if (!existsSync(path.join(desktop, 'build', 'icon.ico'))) {
  console.warn('! Нет desktop/build/icon.ico — запустите: node client/scripts/gen-assets.mjs (в каталоге client)');
}
writeFileSync(path.join(out, 'BUILD.json'), JSON.stringify({ builtAt: new Date().toISOString() }, null, 2));
console.log('✓ Готово: desktop/app');
