import type { Address, Hex } from 'viem';

import type { StoredEnvelope } from '../envelope.ts';

export interface EnvelopeRecord {
  /** Namehash of the ENS name, lowercase hex. */
  readonly node: Hex;
  /** The name, when the publisher supplied one. Cosmetic — resolution keys on `node`. */
  readonly name: string | null;
  readonly envelope: StoredEnvelope;
  /** ISO 8601, set by the gateway when it accepted the publish. */
  readonly publishedAt: string;
  /** The address whose signature authorised this publish. */
  readonly publisher: Address;
  /** Monotonic per node. See `lastNonce`. */
  readonly nonce: bigint;
}

export interface StoreProbe {
  readonly ok: boolean;
  /** Human-readable, and specific enough to act on. Never "error". */
  readonly detail: string;
  readonly records: number;
  readonly latencyMs: number;
}

/**
 * Where published envelopes live.
 *
 * Deliberately narrow: the gateway holds public metadata keyed by node, and
 * nothing else. Two implementations ship — in-memory for tests and for a Worker,
 * file-backed for the demo — so the whole thing runs with no database.
 */
export interface EnvelopeStore {
  readonly kind: string;
  /** What a health probe should say about this backend when it is working. */
  readonly description: string;

  get(node: Hex): Promise<EnvelopeRecord | undefined>;
  put(record: EnvelopeRecord): Promise<void>;
  list(): Promise<readonly EnvelopeRecord[]>;

  /**
   * The highest nonce ever accepted for a node, whether or not a record is still
   * held.
   *
   * A publish is a signed message, and a signed message that can be replayed is a
   * rollback: anyone who saw an old publish could re-submit it and revert the name
   * to a superseded envelope. The nonce has to outlive the record it authorised for
   * that to be impossible.
   */
  lastNonce(node: Hex): Promise<bigint>;

  probe(): Promise<StoreProbe>;
}
