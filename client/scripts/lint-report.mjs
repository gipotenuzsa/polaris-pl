// Краткий отчёт ESLint: node scripts/lint-report.mjs
import { execFileSync } from 'node:child_process';

let out = '';
try {
  out = execFileSync('npx', ['eslint', '.', '-f', 'json'], { encoding: 'utf8', shell: true, maxBuffer: 50_000_000 });
} catch (e) {
  out = e.stdout?.toString() ?? '';
}
const report = JSON.parse(out || '[]');
let n = 0;
for (const f of report) {
  for (const m of f.messages) {
    n++;
    console.log(
      `${f.filePath.replace(/.*client[\\/]/, '')}:${m.line}:${m.column} ${m.ruleId} — ${m.message.split('\n')[0].slice(0, 140)}`,
    );
  }
}
console.log(`Проблем: ${n}`);
process.exit(n ? 1 : 0);
