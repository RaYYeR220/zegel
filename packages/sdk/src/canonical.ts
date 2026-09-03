import { sha256 } from '@noble/hashes/sha2';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils';

/**
 * Deterministic JSON encoding.
 *
 * Object keys are emitted in sorted order and `undefined` members are dropped, so
 * two structurally equal values always encode to the same bytes regardless of how
 * they were built. Every digest and commitment in Zegel goes through here — if a
 * second encoder appears, commitments stop matching across modules.
 */
export function canonicalize(value: unknown): string {
  return encode(value);
}

function encode(value: unknown): string {
  if (value === null) return 'null';

  const t = typeof value;
  if (t === 'number') {
    if (!Number.isFinite(value as number)) {
      throw new TypeError('cannot canonicalize a non-finite number');
    }
    return JSON.stringify(value);
  }
  if (t === 'string' || t === 'boolean') return JSON.stringify(value);
  if (t === 'bigint') return JSON.stringify((value as bigint).toString());

  if (Array.isArray(value)) {
    return `[${value.map((v) => encode(v === undefined ? null : v)).join(',')}]`;
  }

  if (t === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${encode(v)}`).join(',')}}`;
  }

  throw new TypeError(`cannot canonicalize ${t}`);
}

/** sha256 of the canonical encoding, `0x`-prefixed hex. */
export function canonicalDigest(value: unknown): string {
  return `0x${bytesToHex(sha256(utf8ToBytes(canonicalize(value))))}`;
}

/** Constant-time-ish equality for digests, to keep comparisons off the fast path. */
export function digestsEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
