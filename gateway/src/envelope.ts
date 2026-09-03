import { sha256, stringToHex, type Hex } from 'viem';

import { ENVELOPE_SCHEMA, type SealedEnvelope } from '../../packages/sdk/src/types.ts';

import { badRequest } from './errors.ts';

/**
 * An envelope as the gateway holds it: the exact bytes, and just enough parsed
 * structure to reason about expiry.
 *
 * The bytes are authoritative and are never re-serialised. The gateway is a byte
 * pipe: the name's owner signed a digest over a specific sequence of bytes, and the
 * only way that signature stays meaningful is if those bytes are what gets served.
 * Re-encoding here — even with the shared canonical encoder — would let an encoder
 * revision silently change what the owner is taken to have signed.
 */
export interface StoredEnvelope {
  /** Canonical JSON text, exactly as published. */
  readonly text: string;
  /** `text` as UTF-8 bytes, hex-encoded. This is what the resolver returns. */
  readonly bytes: Hex;
  /** sha256 over the bytes. Equal to `canonicalDigest(envelope)` for canonical text. */
  readonly digest: Hex;
  readonly envelope: SealedEnvelope;
  /** `expiresAt` as epoch seconds. */
  readonly expiresAtSeconds: number;
}

const HEX32 = /^0x[0-9a-fA-F]{64}$/;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const COMPRESSED_PUBKEY = /^(0x)?[0-9a-fA-F]{66}$/;

/**
 * Parses and checks a published envelope.
 *
 * This is not an attempt to police the payload — the envelope is public metadata
 * and the gateway has no opinion on its contents. It checks the fields the gateway
 * itself relies on (so a broken publish fails at publish time, not at resolve time)
 * and refuses obvious junk so that a name never ends up serving a blob no client can
 * read.
 */
export function parseEnvelope(text: string): StoredEnvelope {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (cause) {
    throw badRequest('envelope is not valid JSON', { cause });
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw badRequest('envelope is not a JSON object');
  }

  const candidate = parsed as Record<string, unknown>;

  if (candidate['schema'] !== ENVELOPE_SCHEMA) {
    throw badRequest(`envelope schema is ${String(candidate['schema'])}, expected ${ENVELOPE_SCHEMA}`);
  }
  requireHex32(candidate['referenceId'], 'referenceId');
  requireHex32(candidate['commitment'], 'commitment');

  const issuedAt = requireTimestamp(candidate['issuedAt'], 'issuedAt');
  const expiresAt = requireTimestamp(candidate['expiresAt'], 'expiresAt');
  if (expiresAt <= issuedAt) {
    throw badRequest('envelope expiresAt is not after issuedAt');
  }

  const tiers = candidate['tiers'];
  if (!Array.isArray(tiers) || tiers.length === 0) {
    throw badRequest('envelope tiers must be a non-empty array');
  }
  tiers.forEach(requireTier);

  const anchors = candidate['anchors'];
  if (typeof anchors !== 'object' || anchors === null || Array.isArray(anchors)) {
    throw badRequest('envelope anchors must be an object');
  }

  const hint = candidate['revocationHint'];
  if (typeof hint !== 'object' || hint === null || Array.isArray(hint)) {
    throw badRequest('envelope revocationHint must be an object');
  }
  const hintRecord = hint as Record<string, unknown>;
  if (typeof hintRecord['contract'] !== 'string' || !ADDRESS.test(hintRecord['contract'])) {
    throw badRequest('envelope revocationHint.contract must be a 20-byte hex address');
  }
  if (typeof hintRecord['chainId'] !== 'number' || !Number.isInteger(hintRecord['chainId'])) {
    throw badRequest('envelope revocationHint.chainId must be an integer');
  }

  const bytes = stringToHex(text);
  return {
    text,
    bytes,
    digest: sha256(bytes),
    envelope: parsed as SealedEnvelope,
    expiresAtSeconds: Math.floor(expiresAt / 1000),
  };
}

/** sha256 over the UTF-8 bytes of the text. Matches `canonicalDigest` in `@zegel/sdk`. */
export function envelopeDigest(text: string): Hex {
  return sha256(stringToHex(text));
}

function requireHex32(value: unknown, field: string): void {
  if (typeof value !== 'string' || !HEX32.test(value)) {
    throw badRequest(`envelope ${field} must be 32 bytes of 0x-prefixed hex`);
  }
}

function requireTimestamp(value: unknown, field: string): number {
  if (typeof value !== 'string') throw badRequest(`envelope ${field} must be an ISO 8601 string`);
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) throw badRequest(`envelope ${field} is not a parseable ISO 8601 timestamp`);
  return ms;
}

function requireTier(value: unknown, index: number): void {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw badRequest(`envelope tiers[${index}] is not an object`);
  }
  const tier = value as Record<string, unknown>;

  if (tier['tier'] !== 1 && tier['tier'] !== 2) {
    throw badRequest(`envelope tiers[${index}].tier must be 1 or 2`);
  }
  for (const field of ['swarmRef', 'actHistoryAddress'] as const) {
    const held = tier[field];
    if (typeof held !== 'string' || held.length === 0) {
      throw badRequest(`envelope tiers[${index}].${field} must be a non-empty string`);
    }
  }
  const publisher = tier['actPublisher'];
  if (typeof publisher !== 'string' || !COMPRESSED_PUBKEY.test(publisher)) {
    throw badRequest(
      `envelope tiers[${index}].actPublisher must be a 33-byte compressed secp256k1 public key`,
    );
  }
}
