/** Hex helpers for the 32-byte identifiers that cross the Zegel wire boundary. */

const HEX32 = /^(0x)?[0-9a-fA-F]{64}$/;

export class HexError extends Error {
  override readonly name = 'HexError';
  constructor(field: string, value: string) {
    super(`${field} must be 32 bytes of hex (64 hex chars, optional 0x prefix), got: ${value}`);
  }
}

/** Normalises to lowercase `0x`-prefixed form. Rejects anything that is not exactly 32 bytes. */
export function normalizeHex32(field: string, value: string): string {
  if (typeof value !== 'string' || !HEX32.test(value)) throw new HexError(field, String(value));
  return `0x${value.replace(/^0x/, '').toLowerCase()}`;
}

export function hex32ToBytes(field: string, value: string): Uint8Array {
  const normalized = normalizeHex32(field, value).slice(2);
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) out[i] = Number.parseInt(normalized.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function bytesToHex32(field: string, bytes: ArrayLike<number>): string {
  if (bytes.length !== 32) {
    throw new HexError(field, `<${bytes.length} bytes>`);
  }
  let out = '';
  for (let i = 0; i < 32; i++) out += (bytes[i] as number).toString(16).padStart(2, '0');
  return `0x${out}`;
}

/** Case-insensitive comparison that does not short-circuit on the first differing byte. */
export function hexEqual(a: string, b: string): boolean {
  const x = a.replace(/^0x/, '').toLowerCase();
  const y = b.replace(/^0x/, '').toLowerCase();
  if (x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return diff === 0;
}
