import { describe, expect, it } from 'vitest';
import { getSchemaDecoder } from 'sas-lib';
import {
  assertSchemaMatchesExpected,
  decodeFieldNames,
  decodeReferenceData,
  encodeFieldNames,
  encodeReferenceData,
  localSchemaAccount,
  normalizeReferenceData,
  SchemaDriftError,
  schemaMatchesExpected,
  ZEGEL_SCHEMA_DATA_SIZE,
  ZEGEL_SCHEMA_FIELDS,
  ZEGEL_SCHEMA_LAYOUT,
} from '../src/schema.ts';
import { HexError, normalizeHex32 } from '../src/hex.ts';
import { toUnixSeconds } from '../src/issue.ts';
import { COMMITMENT, DERIVATION_ID, REFERENCE_ID, schemaAccountBytes, TAMPERED_COMMITMENT } from './fixtures.ts';

const sample = {
  referenceId: REFERENCE_ID,
  commitment: COMMITMENT,
  expiresAt: 1_893_456_000n,
  derivationId: DERIVATION_ID,
  tierCount: 2,
};

describe('reference schema layout', () => {
  it('describes five fields with a matching layout', () => {
    expect(ZEGEL_SCHEMA_FIELDS).toEqual([
      'referenceId',
      'commitment',
      'expiresAt',
      'derivationId',
      'tierCount',
    ]);
    expect(ZEGEL_SCHEMA_LAYOUT).toHaveLength(ZEGEL_SCHEMA_FIELDS.length);
    // Vec<u8>, Vec<u8>, u64, Vec<u8>, u8 in the program's compact layout encoding.
    expect(ZEGEL_SCHEMA_LAYOUT).toEqual([13, 13, 3, 13, 0]);
  });

  it('round-trips field names through the program\'s joined-vector encoding', () => {
    const encoded = encodeFieldNames(ZEGEL_SCHEMA_FIELDS);
    expect(decodeFieldNames(encoded)).toEqual([...ZEGEL_SCHEMA_FIELDS]);
    // 4-byte little-endian length prefix per field, then the utf-8 bytes.
    const expectedSize = ZEGEL_SCHEMA_FIELDS.reduce((n, f) => n + 4 + f.length, 0);
    expect(encoded).toHaveLength(expectedSize);
  });
});

describe('borsh codec', () => {
  it('encodes to the documented fixed size', () => {
    expect(encodeReferenceData(sample)).toHaveLength(ZEGEL_SCHEMA_DATA_SIZE);
    expect(ZEGEL_SCHEMA_DATA_SIZE).toBe(117);
  });

  it('round-trips every field', () => {
    expect(decodeReferenceData(encodeReferenceData(sample))).toEqual(sample);
  });

  it('is deterministic', () => {
    expect(Array.from(encodeReferenceData(sample))).toEqual(Array.from(encodeReferenceData(sample)));
  });

  it('round-trips through a schema account decoded from raw bytes', () => {
    // The verify path decodes against the schema it fetched, not a local assumption.
    const fetched = getSchemaDecoder().decode(schemaAccountBytes());
    const bytes = encodeReferenceData(sample, fetched);
    expect(decodeReferenceData(bytes, fetched)).toEqual(sample);
    expect(Array.from(bytes)).toEqual(Array.from(encodeReferenceData(sample)));
  });

  it('round-trips boundary values', () => {
    const edge = {
      referenceId: `0x${'00'.repeat(32)}`,
      commitment: `0x${'ff'.repeat(32)}`,
      expiresAt: 18_446_744_073_709_551_615n,
      derivationId: `0x${'00'.repeat(31)}01`,
      tierCount: 255,
    };
    expect(decodeReferenceData(encodeReferenceData(edge))).toEqual(edge);
  });

  it('normalises unprefixed and mixed-case hex to the same bytes', () => {
    const upper = {
      ...sample,
      commitment: COMMITMENT.slice(2).toUpperCase(),
    };
    expect(Array.from(encodeReferenceData(upper))).toEqual(Array.from(encodeReferenceData(sample)));
    expect(normalizeReferenceData(upper).commitment).toBe(COMMITMENT);
  });

  it('produces different bytes for a one-byte commitment change', () => {
    const tampered = { ...sample, commitment: TAMPERED_COMMITMENT };
    const a = encodeReferenceData(sample);
    const b = encodeReferenceData(tampered);
    expect(Array.from(a)).not.toEqual(Array.from(b));
    expect(decodeReferenceData(b).commitment).toBe(TAMPERED_COMMITMENT);
  });

  it('rejects identifiers that are not exactly 32 bytes', () => {
    expect(() => encodeReferenceData({ ...sample, referenceId: '0xdeadbeef' })).toThrow(HexError);
    expect(() => encodeReferenceData({ ...sample, commitment: `0x${'ab'.repeat(33)}` })).toThrow(HexError);
    expect(() => encodeReferenceData({ ...sample, derivationId: `0x${'zz'.repeat(32)}` })).toThrow(HexError);
  });

  it('rejects out-of-range scalars', () => {
    expect(() => encodeReferenceData({ ...sample, tierCount: 256 })).toThrow(RangeError);
    expect(() => encodeReferenceData({ ...sample, tierCount: -1 })).toThrow(RangeError);
    expect(() => encodeReferenceData({ ...sample, expiresAt: -1n })).toThrow(RangeError);
  });
});

describe('schema drift detection', () => {
  it('accepts the canonical schema', () => {
    expect(schemaMatchesExpected(localSchemaAccount())).toBe(true);
    expect(() => assertSchemaMatchesExpected(localSchemaAccount())).not.toThrow();
  });

  it('rejects a reordered field list', () => {
    const drifted = {
      ...localSchemaAccount(),
      fieldNames: encodeFieldNames(['commitment', 'referenceId', 'expiresAt', 'derivationId', 'tierCount']),
    };
    expect(schemaMatchesExpected(drifted)).toBe(false);
    expect(() => assertSchemaMatchesExpected(drifted)).toThrow(SchemaDriftError);
  });

  it('rejects a changed type layout', () => {
    const drifted = { ...localSchemaAccount(), layout: Uint8Array.from([13, 13, 4, 13, 0]) };
    expect(schemaMatchesExpected(drifted)).toBe(false);
    expect(() => assertSchemaMatchesExpected(drifted)).toThrow(SchemaDriftError);
  });

  it('rejects an added field', () => {
    const drifted = {
      ...localSchemaAccount(),
      layout: Uint8Array.from([13, 13, 3, 13, 0, 0]),
      fieldNames: encodeFieldNames([...ZEGEL_SCHEMA_FIELDS, 'extra']),
    };
    expect(schemaMatchesExpected(drifted)).toBe(false);
  });
});

describe('hex normalisation', () => {
  it('lowercases and prefixes', () => {
    expect(normalizeHex32('x', 'AB'.repeat(32))).toBe(`0x${'ab'.repeat(32)}`);
  });

  it('names the offending field', () => {
    expect(() => normalizeHex32('commitment', 'nope')).toThrow(/commitment/);
  });
});

describe('expiry parsing', () => {
  it('reads ISO 8601', () => {
    expect(toUnixSeconds('2030-01-01T00:00:00.000Z')).toBe(1_893_456_000n);
  });

  it('reads a Date', () => {
    expect(toUnixSeconds(new Date('2030-01-01T00:00:00.000Z'))).toBe(1_893_456_000n);
  });

  it('reads unix seconds as a number and as a numeric string', () => {
    expect(toUnixSeconds(1_893_456_000)).toBe(1_893_456_000n);
    expect(toUnixSeconds('1893456000')).toBe(1_893_456_000n);
  });

  it('tolerates a millisecond timestamp', () => {
    expect(toUnixSeconds(1_893_456_000_000)).toBe(1_893_456_000n);
  });

  it('refuses an unparseable value', () => {
    expect(() => toUnixSeconds('next tuesday')).toThrow(TypeError);
  });
});
