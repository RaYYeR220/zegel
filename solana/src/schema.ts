/**
 * The Zegel reference schema and its Borsh codec.
 *
 * Five fields, fixed forever at version 1. A schema is consensus between issuer
 * and verifier: anything added later has to arrive as a new schema version with
 * its own PDA, so this list stays deliberately short and carries no claim
 * contents — only the public commitment and the metadata needed to check it.
 *
 *   referenceId   32 bytes  the reference this attestation anchors
 *   commitment    32 bytes  sha256 over the canonical ClaimSet
 *   expiresAt     u64       unix seconds; mirrors the attestation `expiry` field
 *   derivationId  32 bytes  pins which derivation produced the claims
 *   tierCount     u8        how many sealed disclosure tiers exist
 */

import { type Schema, deserializeAttestationData, serializeAttestationData } from 'sas-lib';
import type { Address } from '@solana/kit';
import { ACCOUNT_DISCRIMINATOR, SCHEMA_NAME, SCHEMA_VERSION } from './constants.ts';
import { bytesToHex32, hex32ToBytes, normalizeHex32 } from './hex.ts';

/**
 * The compact layout byte for each supported field type, mirroring the mapping the
 * on-chain program uses. Only the two we need are named; the byte values are the
 * program's, not ours.
 */
export const SchemaDataType = {
  U8: 0,
  U64: 3,
  VecU8: 13,
} as const;

export const ZEGEL_SCHEMA_FIELDS = [
  'referenceId',
  'commitment',
  'expiresAt',
  'derivationId',
  'tierCount',
] as const;

export const ZEGEL_SCHEMA_LAYOUT: readonly number[] = [
  SchemaDataType.VecU8,
  SchemaDataType.VecU8,
  SchemaDataType.U64,
  SchemaDataType.VecU8,
  SchemaDataType.U8,
];

/** Serialized size: three length-prefixed 32-byte vectors, a u64 and a u8. */
export const ZEGEL_SCHEMA_DATA_SIZE = 3 * (4 + 32) + 8 + 1;

export interface ReferenceAttestationData {
  /** 32-byte hex, `0x`-prefixed. */
  referenceId: string;
  /** 32-byte hex, `0x`-prefixed. sha256 over the canonical ClaimSet. */
  commitment: string;
  /** Unix seconds. */
  expiresAt: bigint;
  /** 32-byte hex, `0x`-prefixed. */
  derivationId: string;
  tierCount: number;
}

export class SchemaDriftError extends Error {
  override readonly name = 'SchemaDriftError';
  constructor(message: string) {
    super(message);
  }
}

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

/**
 * The program stores field names as a run of length-prefixed byte vectors rather
 * than a Borsh `Vec<String>` header, so it has to be built by hand.
 */
export function encodeFieldNames(fields: readonly string[]): Uint8Array {
  const parts = fields.map((f) => textEncoder.encode(f));
  const total = parts.reduce((n, p) => n + 4 + p.length, 0);
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  let offset = 0;
  for (const part of parts) {
    view.setUint32(offset, part.length, true);
    offset += 4;
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

export function decodeFieldNames(bytes: Uint8Array): string[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out: string[] = [];
  let offset = 0;
  while (offset + 4 <= bytes.length) {
    const len = view.getUint32(offset, true);
    offset += 4;
    out.push(textDecoder.decode(bytes.subarray(offset, offset + len)));
    offset += len;
  }
  return out;
}

/**
 * A local stand-in for the on-chain schema account, so encoding works offline and
 * in tests. Only `layout` and `fieldNames` are read by the codec; the rest is
 * filled in so the value is a well-formed `Schema`.
 */
export function localSchemaAccount(credential?: Address): Schema {
  return {
    discriminator: ACCOUNT_DISCRIMINATOR.schema,
    credential: (credential ?? ('11111111111111111111111111111111' as Address)) as Address,
    name: textEncoder.encode(SCHEMA_NAME),
    description: new Uint8Array(0),
    layout: Uint8Array.from(ZEGEL_SCHEMA_LAYOUT),
    fieldNames: encodeFieldNames(ZEGEL_SCHEMA_FIELDS),
    isPaused: false,
    version: SCHEMA_VERSION,
  };
}

/**
 * Confirms a fetched schema account still describes the layout this package
 * encodes against. A verifier that skips this can decode garbage into a
 * plausible-looking commitment.
 */
export function assertSchemaMatchesExpected(schema: Schema): void {
  const layout = Array.from(schema.layout);
  if (
    layout.length !== ZEGEL_SCHEMA_LAYOUT.length ||
    layout.some((b, i) => b !== ZEGEL_SCHEMA_LAYOUT[i])
  ) {
    throw new SchemaDriftError(
      `on-chain schema layout [${layout.join(',')}] does not match expected [${ZEGEL_SCHEMA_LAYOUT.join(',')}]`,
    );
  }
  const names = decodeFieldNames(Uint8Array.from(schema.fieldNames));
  if (names.length !== ZEGEL_SCHEMA_FIELDS.length || names.some((n, i) => n !== ZEGEL_SCHEMA_FIELDS[i])) {
    throw new SchemaDriftError(
      `on-chain schema fields [${names.join(',')}] do not match expected [${ZEGEL_SCHEMA_FIELDS.join(',')}]`,
    );
  }
}

export function schemaMatchesExpected(schema: Schema): boolean {
  try {
    assertSchemaMatchesExpected(schema);
    return true;
  } catch {
    return false;
  }
}

function toBorshRecord(data: ReferenceAttestationData): Record<string, unknown> {
  if (!Number.isInteger(data.tierCount) || data.tierCount < 0 || data.tierCount > 255) {
    throw new RangeError(`tierCount must be a u8, got ${data.tierCount}`);
  }
  if (data.expiresAt < 0n || data.expiresAt > 0xffff_ffff_ffff_ffffn) {
    throw new RangeError(`expiresAt must be a u64, got ${data.expiresAt}`);
  }
  return {
    referenceId: Array.from(hex32ToBytes('referenceId', data.referenceId)),
    commitment: Array.from(hex32ToBytes('commitment', data.commitment)),
    expiresAt: data.expiresAt,
    derivationId: Array.from(hex32ToBytes('derivationId', data.derivationId)),
    tierCount: data.tierCount,
  };
}

/** Borsh-encodes the attestation payload against a schema account. */
export function encodeReferenceData(
  data: ReferenceAttestationData,
  schema: Schema = localSchemaAccount(),
): Uint8Array {
  return Uint8Array.from(serializeAttestationData(schema, toBorshRecord(data)));
}

/**
 * Borsh-decodes attestation data. Pass the fetched on-chain schema when verifying —
 * decoding a live attestation against a locally-assumed layout is exactly the
 * shortcut that turns schema drift into a silently wrong answer.
 */
export function decodeReferenceData(
  bytes: Uint8Array,
  schema: Schema = localSchemaAccount(),
): ReferenceAttestationData {
  const raw = deserializeAttestationData<Record<string, unknown>>(schema, bytes);
  return {
    referenceId: bytesToHex32('referenceId', raw['referenceId'] as ArrayLike<number>),
    commitment: bytesToHex32('commitment', raw['commitment'] as ArrayLike<number>),
    expiresAt: BigInt(raw['expiresAt'] as bigint | number | string),
    derivationId: bytesToHex32('derivationId', raw['derivationId'] as ArrayLike<number>),
    tierCount: Number(raw['tierCount']),
  };
}

/** Normalises the hex fields without touching the chain. Throws on malformed input. */
export function normalizeReferenceData(data: ReferenceAttestationData): ReferenceAttestationData {
  return {
    referenceId: normalizeHex32('referenceId', data.referenceId),
    commitment: normalizeHex32('commitment', data.commitment),
    expiresAt: data.expiresAt,
    derivationId: normalizeHex32('derivationId', data.derivationId),
    tierCount: data.tierCount,
  };
}
