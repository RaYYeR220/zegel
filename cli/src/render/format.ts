/**
 * Number and identifier formatting.
 *
 * Every helper here emits the unit with the value. A bare `0.75` in a terminal is
 * a bug report waiting to happen — it could be a ratio, a score, a dollar amount
 * or a day count, and the reader has no way to tell. So the unit travels with the
 * number, always, and the caller cannot forget it.
 */

const USD = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const USD_WHOLE = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 0,
});

const COUNT = new Intl.NumberFormat('en-US');

/** `$1,234.56` / `-$12,526.91`. Sub-cent amounts keep enough digits to stay non-zero. */
export function usd(value: number): string {
  if (!Number.isFinite(value)) return 'unavailable';
  const magnitude = Math.abs(value);
  if (magnitude !== 0 && magnitude < 0.01) {
    return `${value < 0 ? '-' : ''}$${magnitude.toPrecision(2)}`;
  }
  if (magnitude >= 1_000_000) return USD_WHOLE.format(value);
  return USD.format(value);
}

/** Signed, for figures where the direction is the point. */
export function usdSigned(value: number): string {
  if (!Number.isFinite(value)) return 'unavailable';
  return value > 0 ? `+${usd(value)}` : usd(value);
}

/** `20.0%` — a ratio in 0..1 rendered as a percentage. */
export function percent(value: number, digits = 1): string {
  if (!Number.isFinite(value)) return 'unavailable';
  return `${(value * 100).toFixed(digits)}%`;
}

export function count(value: number): string {
  if (!Number.isFinite(value)) return 'unavailable';
  return COUNT.format(value);
}

/** `524.8 days` / `1.0 day`. Long spans also get a years hint, which is how people read them. */
export function days(value: number): string {
  if (!Number.isFinite(value)) return 'unavailable';
  const body = `${value.toFixed(1)} ${Math.abs(value - 1) < 0.05 ? 'day' : 'days'}`;
  if (value >= 730) return `${body} (${(value / 365.25).toFixed(1)} years)`;
  return body;
}

export function score(value: number): string {
  if (!Number.isFinite(value)) return 'unavailable';
  return `${Math.round(value)}/100`;
}

/** Renders a claim's measured value in its declared unit. */
export function inUnit(value: number, unit: 'usd' | 'count' | 'ratio' | 'days' | 'score'): string {
  switch (unit) {
    case 'usd':
      return usd(value);
    case 'ratio':
      return percent(value);
    case 'days':
      return days(value);
    case 'score':
      return score(value);
    case 'count':
      return count(value);
  }
}

/** Renders a claim's threshold, which may be a band. */
export function thresholdIn(
  threshold: number | readonly [number, number],
  unit: 'usd' | 'count' | 'ratio' | 'days' | 'score',
): string {
  if (Array.isArray(threshold)) {
    const [lo, hi] = threshold as readonly [number, number];
    return `${inUnit(lo, unit)}..${inUnit(hi, unit)}`;
  }
  return inUnit(threshold as number, unit);
}

const OPS: Record<string, string> = {
  gte: 'at least',
  lte: 'at most',
  eq: 'exactly',
  between: 'between',
};

export function opWords(op: string): string {
  return OPS[op] ?? op;
}

/** `0xd8dA…6045`. Never truncate to fewer than 4 leading hex digits — collisions get real. */
export function shortAddress(address: string, lead = 6, tail = 4): string {
  if (address.length <= lead + tail + 1) return address;
  return `${address.slice(0, lead)}…${address.slice(-tail)}`;
}

export function shortHex(value: string, lead = 10, tail = 6): string {
  return shortAddress(value, lead, tail);
}

/** `2026-09-04` — dates in output are always UTC and always ISO, never locale-dependent. */
export function isoDay(iso: string | number | Date): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return 'unknown date';
  return d.toISOString().slice(0, 10);
}

export function isoMinute(iso: string | number | Date): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return 'unknown time';
  return `${d.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

/** `06:00-14:00 UTC`, wrapping across midnight where needed. */
export function hourWindow(startHour: number, endHour: number): string {
  const pad = (h: number): string => `${String(((h % 24) + 24) % 24).padStart(2, '0')}:00`;
  return `${pad(startHour)}-${pad(endHour)} UTC`;
}

/** `UTC+6` / `UTC-5` / `UTC`. */
export function utcOffset(hours: number): string {
  if (hours === 0) return 'UTC';
  return `UTC${hours > 0 ? '+' : '-'}${Math.abs(hours)}`;
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return n === 1 ? one : many;
}

/** Wraps prose to a width without breaking mid-word. */
export function wrap(text: string, width: number): string[] {
  const words = text.split(/\s+/).filter((w) => w.length > 0);
  const lines: string[] = [];
  let line = '';
  for (const word of words) {
    if (line.length === 0) line = word;
    else if (line.length + 1 + word.length <= width) line = `${line} ${word}`;
    else {
      lines.push(line);
      line = word;
    }
  }
  if (line.length > 0) lines.push(line);
  return lines.length > 0 ? lines : [''];
}
