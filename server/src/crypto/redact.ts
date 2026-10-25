const SENSITIVE_KEY =
  /(passw(or)?d|secret|api[-_]?key|authorization|cookie|credential|private[-_]?key|(access|refresh|id|auth|bearer|session|csrf|api|oauth)[-_]?token|^token$)/i;

const SECRET_PATTERNS: RegExp[] = [
  /sk-[A-Za-z0-9_-]{16,}/g,
  /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/g,
  /Bearer\s+[A-Za-z0-9._~+/=-]{12,}/gi,
  /AIza[0-9A-Za-z_-]{30,}/g,
  /(ghp|gho|ghu|ghs|github_pat)_[A-Za-z0-9_]{20,}/g,
  /BSA[A-Za-z0-9_-]{20,}/g,
];

const MAX_STRING = 2000;
const MAX_DEPTH = 6;
const MASK = '[скрыто]';

export function redactString(input: string): string {
  let out = input;
  for (const re of SECRET_PATTERNS) out = out.replace(re, MASK);
  if (out.length > MAX_STRING) out = `${out.slice(0, MAX_STRING)}… (+${out.length - MAX_STRING} симв.)`;
  return out;
}

/** Глубокая копия значения без секретов — для журнала действий и логов. */
export function redact(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return redactString(value);
  if (typeof value !== 'object') return value;
  if (depth >= MAX_DEPTH) return '[…]';
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => redact(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = SENSITIVE_KEY.test(k) ? MASK : redact(v, depth + 1);
  }
  return out;
}
