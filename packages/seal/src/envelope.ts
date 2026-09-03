import { canonicalDigest, canonicalize } from '../../sdk/src/canonical.js';

import { EnvelopeError } from './errors.js';

/**
 * What actually goes on Swarm, inside the ACT encryption.
 *
 * The tier payload is wrapped rather than uploaded bare so a reader can tell,
 * before trusting a single field, that they decrypted a Zegel object of the tier
 * they expected and that its bytes were not swapped underneath the reference.
 * The digest is computed with the shared canonical encoder, so it is the same
 * number the envelope's public commitment is built from.
 */
export const SEAL_ENVELOPE_SCHEMA = 'zegel.seal.v1' as const;

export type SealTierNumber = 1 | 2;

export interface SealEnvelope<T> {
  schema: typeof SEAL_ENVELOPE_SCHEMA;
  tier: SealTierNumber;
  /** Ties the sealed object back to the public envelope that points at it. */
  referenceId: string;
  /** `canonicalDigest(payload)`. Checked on decode. */
  digest: string;
  /** ISO 8601, set at upload time. */
  sealedAt: string;
  payload: T;
}

export interface EncodeEnvelopeInput<T> {
  tier: SealTierNumber;
  referenceId: string;
  payload: T;
  /** Defaults to now. Injectable so tests and re-seals are reproducible. */
  sealedAt?: string;
}

/** Builds the envelope object without serialising it. */
export function makeEnvelope<T>(input: EncodeEnvelopeInput<T>): SealEnvelope<T> {
  return {
    schema: SEAL_ENVELOPE_SCHEMA,
    tier: input.tier,
    referenceId: input.referenceId,
    digest: canonicalDigest(input.payload),
    sealedAt: input.sealedAt ?? new Date().toISOString(),
    payload: input.payload,
  };
}

/** Canonical-JSON bytes, ready to upload. */
export function encodeEnvelope<T>(input: EncodeEnvelopeInput<T>): Uint8Array {
  return new TextEncoder().encode(canonicalize(makeEnvelope(input)));
}

/** Serialises an already-built envelope. Round-trips with `decodeEnvelope`. */
export function encodeEnvelopeObject<T>(envelope: SealEnvelope<T>): Uint8Array {
  return new TextEncoder().encode(canonicalize(envelope));
}

/**
 * Parses and verifies bytes fetched from Swarm.
 *
 * Throws rather than returning a partial object: a caller that reached this point
 * already held a valid grant, so a malformed body means tampering or a version
 * mismatch, never a permissions problem.
 */
export function decodeEnvelope<T>(bytes: Uint8Array | string): SealEnvelope<T> {
  const text = typeof bytes === 'string' ? bytes : new TextDecoder().decode(bytes);

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (cause) {
    throw new EnvelopeError('not JSON', { cause });
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new EnvelopeError('not a JSON object');
  }

  const candidate = parsed as Partial<SealEnvelope<T>>;

  if (candidate.schema !== SEAL_ENVELOPE_SCHEMA) {
    throw new EnvelopeError(`schema is ${String(candidate.schema)}, expected ${SEAL_ENVELOPE_SCHEMA}`);
  }
  if (candidate.tier !== 1 && candidate.tier !== 2) {
    throw new EnvelopeError(`tier is ${String(candidate.tier)}, expected 1 or 2`);
  }
  if (typeof candidate.referenceId !== 'string' || candidate.referenceId.length === 0) {
    throw new EnvelopeError('referenceId is missing');
  }
  if (typeof candidate.digest !== 'string') {
    throw new EnvelopeError('digest is missing');
  }
  if (typeof candidate.sealedAt !== 'string') {
    throw new EnvelopeError('sealedAt is missing');
  }
  if (!('payload' in candidate)) {
    throw new EnvelopeError('payload is missing');
  }

  const recomputed = canonicalDigest(candidate.payload);
  if (recomputed !== candidate.digest) {
    throw new EnvelopeError(`digest mismatch: body hashes to ${recomputed}, envelope claims ${candidate.digest}`);
  }

  return candidate as SealEnvelope<T>;
}
