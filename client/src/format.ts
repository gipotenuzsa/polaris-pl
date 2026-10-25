const dtf = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const tf = new Intl.DateTimeFormat('ru-RU', { hour: '2-digit', minute: '2-digit' });

export function formatDateTime(iso?: string): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const now = new Date();
  return d.toDateString() === now.toDateString() ? `сегодня, ${tf.format(d)}` : dtf.format(d);
}

export function formatSchedule(
  s: { type: 'once'; at: string } | { type: 'interval'; everyMinutes: number } | { type: 'daily'; time: string } | null,
): string {
  if (!s) return 'Один раз, сразу';
  if (s.type === 'once') return `Один раз: ${formatDateTime(s.at)}`;
  if (s.type === 'interval') {
    const m = s.everyMinutes;
    return m % 1440 === 0 ? `Каждые ${m / 1440} дн.` : m % 60 === 0 ? `Каждые ${m / 60} ч` : `Каждые ${m} мин`;
  }
  return `Ежедневно в ${s.time}`;
}

export function shorten(text: string, max = 160): string {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} Б`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} КБ`;
  return `${(n / 1024 / 1024).toFixed(1)} МБ`;
}

export function formatNumber(n: number): string {
  return new Intl.NumberFormat('ru-RU').format(Math.round(n));
}

/** «2026-03-01 09:30» или «2026-03-01T09:30» (местное время) → ISO c поясом устройства. */
export function localInputToIso(input: string): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{1,2}):(\d{2})$/.exec(input.trim());
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}
