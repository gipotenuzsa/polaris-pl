export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

export function zonedParts(date: Date, tz: string): ZonedParts {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const p: Record<string, number> = {};
  for (const part of fmt.formatToParts(date)) {
    if (part.type !== 'literal') p[part.type] = Number(part.value);
  }
  return {
    year: p.year ?? 1970,
    month: p.month ?? 1,
    day: p.day ?? 1,
    hour: p.hour ?? 0,
    minute: p.minute ?? 0,
    second: p.second ?? 0,
  };
}

function tzOffsetMs(date: Date, tz: string): number {
  const p = zonedParts(date, tz);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(date.getTime() / 1000) * 1000;
}

/** Локальное время в зоне tz → момент UTC. */
export function zonedTimeToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  tz: string,
): Date {
  const guess = Date.UTC(year, month - 1, day, hour, minute);
  const off = tzOffsetMs(new Date(guess), tz);
  let utc = guess - off;
  const off2 = tzOffsetMs(new Date(utc), tz);
  if (off2 !== off) utc = guess - off2; // переход на летнее/зимнее время
  return new Date(utc);
}

export function startOfDay(date: Date, tz: string): Date {
  const p = zonedParts(date, tz);
  return zonedTimeToUtc(p.year, p.month, p.day, 0, 0, tz);
}

export function dayKey(date: Date, tz: string): string {
  const p = zonedParts(date, tz);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

export function parseHHMM(time: string): { hour: number; minute: number } | null {
  const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(time.trim());
  if (!m) return null;
  return { hour: Number(m[1]), minute: Number(m[2]) };
}

/** Ближайшее наступление HH:MM в зоне tz строго после `after`. */
export function nextDailyRun(time: string, tz: string, after: Date): Date {
  const t = parseHHMM(time);
  if (!t) throw new Error(`Некорректное время: ${time}`);
  const p = zonedParts(after, tz);
  let cand = zonedTimeToUtc(p.year, p.month, p.day, t.hour, t.minute, tz);
  if (cand.getTime() <= after.getTime()) {
    const next = new Date(Date.UTC(p.year, p.month - 1, p.day + 1));
    cand = zonedTimeToUtc(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate(), t.hour, t.minute, tz);
  }
  return cand;
}

export type Schedule =
  | { type: 'once'; at: string }
  | { type: 'interval'; everyMinutes: number }
  | { type: 'daily'; time: string; timezone?: string };

/** Когда впервые запускать задачу с таким расписанием. */
export function firstRun(schedule: Schedule | null | undefined, now: Date, defaultTz: string): Date {
  if (!schedule) return now;
  switch (schedule.type) {
    case 'once': {
      const at = new Date(schedule.at);
      return at.getTime() > now.getTime() ? at : now;
    }
    case 'interval':
      return now;
    case 'daily':
      return nextDailyRun(schedule.time, schedule.timezone ?? defaultTz, now);
  }
}

/** Следующий запуск после завершения предыдущего; null — задача разовая. */
export function nextRun(schedule: Schedule | null | undefined, after: Date, defaultTz: string): Date | null {
  if (!schedule) return null;
  switch (schedule.type) {
    case 'once':
      return null;
    case 'interval':
      return new Date(after.getTime() + schedule.everyMinutes * 60_000);
    case 'daily':
      return nextDailyRun(schedule.time, schedule.timezone ?? defaultTz, after);
  }
}
