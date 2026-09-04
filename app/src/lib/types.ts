/**
 * What crosses the wire between this app's server routes and its pages.
 *
 * The protocol types themselves — `ClaimSet`, `EvidenceBundle`, `SealedEnvelope` —
 * are not redefined here. They live in `@zegel/sdk` and are imported, so there is
 * one definition of anything that gets hashed into a commitment.
 */

import type { ExposureReport } from '@zegel/cli/exposure';
import type { ClaimSet, Claim, SealedEnvelope, SealedTier } from '@zegel/sdk/types';
import type { RateLimitSnapshot } from '@zegel/evidence';

export type { ExposureReport };

export interface Subject {
  /** Checksummed address. */
  address: string;
  /** Present when the input was a name that resolved. */
  ensName: string | null;
  via: 'literal' | 'ens';
}

/** The live Mobula credit meter, straight from `x-ratelimit-*`. */
export interface CreditMeter {
  spent: number;
  latest: RateLimitSnapshot | null;
  /** Host that answered, so a reader can tell demo from keyed. */
  host: string;
  keyed: boolean;
}

export interface CollectProgressEvent {
  endpoint: string;
  status: 'ok' | 'unavailable';
  httpStatus: number | null;
  done: number;
  total: number;
}

export interface ExposureResult {
  subject: Subject;
  report: ExposureReport;
  credits: CreditMeter;
  collectedAt: string;
}

export interface SealOutcome {
  attempted: boolean;
  backend: {
    kind: 'gateway' | 'node';
    url: string;
    confidentiality: 'key-bound' | 'obscurity';
    canManageGrantees: boolean;
    limitations: readonly string[];
  } | null;
  tiers: readonly SealedTier[];
  /** Sealed but not publishable — the backend never exposed a publisher key. */
  unpublishable: number;
  error: string | null;
}

/**
 * The whole state of one issued reference, held by the browser.
 *
 * The server keeps nothing: there is no filesystem on Vercel, and a reference
 * that only exists inside one warm lambda is a reference that disappears. The
 * ACT history address is irrecoverable if lost, so it lives where the issuer can
 * see it and export it.
 */
export interface ReferenceRecord {
  referenceId: string;
  commitment: string;
  issuedAt: string;
  expiresAt: string;
  subjectAddress: string;
  ensName: string | null;
  window: { from: string; to: string };
  /** One entry per sealed tier, carrying the three ACT coordinates. */
  tiers: readonly StoredTier[];
  envelope: SealedEnvelope;
  claimSet: ClaimSet;
  anchor: { txHash: string; chainId: number } | null;
  /**
   * The issuer's own copy of what they have done to the grantee list.
   *
   * The live list on the node is authoritative for who can read *now*; this is
   * the paper trail of how it got that way, and it is the only place a revoked
   * reader is still visible — a ledger that can be tidied up is worth nothing.
   */
  history?: readonly AccessEvent[];
}

export interface AccessEvent {
  action: 'grant' | 'revoke';
  publicKey: string;
  address: string;
  tier: 1 | 2;
  at: string;
  /** The reference the object had before this change, so the trail is checkable. */
  previousRef: string;
}

export interface StoredTier {
  tier: 1 | 2;
  swarmRef: string;
  actHistoryAddress: string;
  actPublisher: string;
  /** Needed to patch the grantee list later. Absent when the seal created no list. */
  granteeListRef?: string;
  sealedAt: string;
  bytes: number;
}

export interface GranteeView {
  publicKey: string;
  /** The address that key hashes to, so a person can recognise their own. */
  address: string;
}

export interface AccessLedger {
  tier: 1 | 2;
  /** Read back from the node's own ACT grantee list, not from anything we stored. */
  grantees: readonly GranteeView[];
  /** Null when the publisher node could not be reached at all. */
  available: boolean;
  detail: string;
}

export type ReadOutcome =
  | {
      granted: true;
      status: number;
      bytes: number;
      payload: unknown;
      via: string;
      /** `schema` of whatever came back, so the desk can name what it opened. */
      schema: string | null;
      /** True when the bytes were wrapped in a `zegel.seal.v1` envelope and its digest checked out. */
      sealed: boolean;
    }
  | { granted: false; status: number; message: string; via: string };

export interface ReadReport {
  /** The second Bee node, standing in for the person you granted. */
  reader: ReadOutcome | { unavailable: true; detail: string };
  /** Same object, same coordinates, no ACT credentials at all. What the world gets. */
  anonymous: ReadOutcome;
  /** The publisher's own node. Proof the bytes are still there, so a 404 above is access, not absence. */
  publisher: ReadOutcome;
  at: string;
}

export type Verdict = 'valid' | 'expired' | 'revoked' | 'tampered' | 'not-granted' | 'not-found';

export interface VerifyResult {
  /** How the envelope was obtained. */
  source: { kind: 'ens' | 'record' | 'pasted'; detail: string };
  envelope: SealedEnvelope | null;
  mrz: { line1: string; line2: string } | null;
  anchor: {
    status: string;
    summary: string;
    contract: string;
    chainId: number;
    record: {
      commitment: string;
      issuer: string;
      expiresAt: string;
      anchoredAt: string;
      revokedAt: string | null;
    } | null;
  } | null;
  /** What the reader node got back, per tier. */
  reads: readonly { tier: 1 | 2; outcome: ReadOutcome }[];
  /** Present when a tier-1 claim set was actually opened. */
  claimSet: ClaimSet | null;
  commitment: { expected: string; recomputed: string; matches: boolean } | null;
  /** Present when tier 2 was opened and the derivation was re-run from raw bodies. */
  rederivation: {
    ran: boolean;
    ok: boolean;
    /**
     * Whether every claim re-derived to the same value.
     *
     * Kept apart from `ok` because the two failures mean different things to a
     * reader: a claim that disagrees with its own evidence is a false statement,
     * while a source whose body no longer hashes to its recorded digest is
     * evidence that changed after it was recorded. Both are refusals; collapsing
     * them into one would make the desk say the wrong thing.
     */
    claimsAgree: boolean;
    mismatches: readonly string[];
    comparisons: readonly { id: string; statement: string; declared: string; rederived: string; agrees: boolean }[];
  } | null;
  verdict: Verdict;
  headline: string;
  detail: string;
  at: string;
}

export interface ProbeRow {
  id: string;
  name: string;
  status: 'ok' | 'degraded' | 'unavailable' | 'not-configured';
  endpoint: string;
  detail: string;
  cost: string;
  latencyMs: number | null;
}

export interface HealthReport {
  probes: readonly ProbeRow[];
  summary: {
    ok: number;
    degraded: number;
    unavailable: number;
    notConfigured: number;
    demoPathReady: boolean;
    blocking: readonly string[];
  };
  at: string;
}
