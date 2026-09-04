/**
 * Rendering numbers the way a document renders them.
 *
 * Dutch decimals throughout, because the document is set in Dutch and a booklet
 * that mixes 1,234.50 with 1.234,50 reads as a forgery. Money keeps its sign: a
 * loss that renders as a plain number is a loss the reader will misread.
 */

import type { Claim, ClaimUnit } from '@zegel/sdk/types';

const NL = 'nl-NL';

export function usd(value: number, options: { sign?: boolean } = {}): string {
  const abs = Math.abs(value);
  const digits = abs >= 1000 ? 0 : 2;
  const body = abs.toLocaleString(NL, {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
  const prefix = value < 0 ? '−' : options.sign === true ? '+' : '';
  return `${prefix}$${body}`;
}

export function count(value: number): string {
  return Math.round(value).toLocaleString(NL);
}

export function ratio(value: number, digits = 1): string {
  return `${(value * 100).toLocaleString(NL, {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  })}%`;
}

export function days(value: number): string {
  if (value >= 365) {
    const years = Math.floor(value / 365);
    const months = Math.floor((value - years * 365) / 30);
    return months === 0 ? `${years} j` : `${years} j ${months} m`;
  }
  return `${value.toLocaleString(NL, { maximumFractionDigits: 1 })} d`;
}

export function byUnit(value: number, unit: ClaimUnit): string {
  switch (unit) {
    case 'usd':
      return usd(value, { sign: true });
    case 'ratio':
      return ratio(value);
    case 'days':
      return days(value);
    case 'score':
      return value.toLocaleString(NL, { maximumFractionDigits: 0 });
    case 'count':
    default:
      return count(value);
  }
}

/** The bar a claim had to clear, in the same units as its measured value. */
export function thresholdText(claim: Pick<Claim, 'op' | 'threshold' | 'unit'>): string {
  const render = (value: number): string => byUnit(value, claim.unit);
  if (Array.isArray(claim.threshold)) {
    const [low, high] = claim.threshold as readonly [number, number];
    return `${render(low)} – ${render(high)}`;
  }
  const bar = render(claim.threshold as number);
  switch (claim.op) {
    case 'gte':
      return `≥ ${bar}`;
    case 'lte':
      return `≤ ${bar}`;
    default:
      return `= ${bar}`;
  }
}

const MONTHS_NL = ['JAN', 'FEB', 'MRT', 'APR', 'MEI', 'JUN', 'JUL', 'AUG', 'SEP', 'OKT', 'NOV', 'DEC'];

/** `04 SEP 2026`, the way a passport prints a date. */
export function stampDate(iso: string | Date): string {
  const date = typeof iso === 'string' ? new Date(iso) : iso;
  if (Number.isNaN(date.getTime())) return 'ONBEKEND';
  return `${String(date.getUTCDate()).padStart(2, '0')} ${MONTHS_NL[date.getUTCMonth()]} ${date.getUTCFullYear()}`;
}

export function stampDateTime(iso: string | Date): string {
  const date = typeof iso === 'string' ? new Date(iso) : iso;
  if (Number.isNaN(date.getTime())) return 'ONBEKEND';
  const hh = String(date.getUTCHours()).padStart(2, '0');
  const mm = String(date.getUTCMinutes()).padStart(2, '0');
  return `${stampDate(date)} ${hh}:${mm} UTC`;
}

export function shortHex(value: string, head = 10, tail = 6): string {
  if (value.length <= head + tail + 1) return value;
  return `${value.slice(0, head)}…${value.slice(-tail)}`;
}

/** `UTC+01:00` from a whole-hour offset. */
export function utcOffset(hours: number): string {
  const sign = hours < 0 ? '−' : '+';
  return `UTC${sign}${String(Math.abs(hours)).padStart(2, '0')}:00`;
}
