import type { SealedTier } from '../../sdk/src/types.js';

import type { BackendKind } from './backend.js';
import type { SealTierNumber } from './envelope.js';
import { PublisherUnknownError } from './errors.js';
import { granteePublicKey, type GranteePublicKey } from './pubkey.js';
import { historyAddress, swarmReference, type HistoryAddress, type SwarmReference } from './refs.js';

/**
 * The three coordinates an ACT read needs.
 *
 * They travel as one value on purpose: there is no call shape in this package that
 * takes a reference without also taking the history address, so the history
 * address cannot be dropped by a caller who only kept "the hash".
 */
export interface SealCoordinates {
  readonly swarmRef: SwarmReference;
  /** 🔴 Irrecoverable if lost. Swarm has no recovery path for it. */
  readonly actHistoryAddress: HistoryAddress;
  readonly actPublisher: GranteePublicKey;
}

export interface GranteeOutcome {
  /** Keys written into the ACT grantee list. */
  readonly applied: readonly GranteePublicKey[];
  /**
   * Keys the caller asked for that this backend could not apply. Non-empty only
   * when the caller explicitly opted into deferral instead of the default throw.
   */
  readonly deferred: readonly GranteePublicKey[];
  readonly reason?: string;
}

export interface SealReceipt {
  readonly tier: SealTierNumber;
  readonly referenceId: string;
  readonly swarmRef: SwarmReference;
  /** 🔴 Irrecoverable if lost. */
  readonly actHistoryAddress: HistoryAddress;
  /**
   * Null when the backend does not expose its public key — the public gateway
   * 404s `/addresses`. Sealing still succeeds; reading back does not, and the
   * receipt says so rather than carrying a plausible-looking wrong value.
   */
  readonly actPublisher: GranteePublicKey | null;
  /** `canonicalDigest` of the sealed payload — the number the public commitment uses. */
  readonly digest: string;
  readonly sealedAt: string;
  readonly backend: BackendKind;
  readonly backendUrl: string;
  readonly batchId: string;
  /** Grantee-list reference, needed to patch the list later. Absent when no list was created. */
  readonly granteeListRef?: SwarmReference;
  readonly grantees: GranteeOutcome;
  readonly bytes: number;
}

/** True when this receipt is complete enough to read back or publish. */
export function isReadable(receipt: SealReceipt): boolean {
  return receipt.actPublisher !== null;
}

/**
 * Extracts the read coordinates.
 *
 * Throws when the publisher is unknown rather than returning a half-usable object:
 * a read attempted with a missing publisher returns 404, which would be reported
 * as "not granted" and quietly misrepresent a configuration fault as a privacy
 * outcome.
 */
export function coordinatesOf(receipt: SealReceipt): SealCoordinates {
  if (!receipt.actPublisher) throw new PublisherUnknownError(receipt.backendUrl);
  return {
    swarmRef: receipt.swarmRef,
    actHistoryAddress: receipt.actHistoryAddress,
    actPublisher: receipt.actPublisher,
  };
}

/** Narrows a receipt to the public tier record the ENS envelope carries. */
export function toSealedTier(receipt: SealReceipt): SealedTier {
  if (!receipt.actPublisher) throw new PublisherUnknownError(receipt.backendUrl);
  return {
    tier: receipt.tier,
    swarmRef: receipt.swarmRef,
    actHistoryAddress: receipt.actHistoryAddress,
    actPublisher: receipt.actPublisher,
  };
}

/**
 * Rebuilds coordinates from a persisted or resolved tier record.
 *
 * The validation is not decoration: a truncated history address read out of a
 * config file produces a 404 indistinguishable from a revocation, and chasing
 * that costs hours.
 */
export function coordinatesFromTier(tier: SealedTier): SealCoordinates {
  return {
    swarmRef: swarmReference(tier.swarmRef),
    actHistoryAddress: historyAddress(tier.actHistoryAddress),
    actPublisher: granteePublicKey(tier.actPublisher),
  };
}
