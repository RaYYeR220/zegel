import { CLAIMS_SCHEMA, canonicalDigest } from './sdk.js';
import type { Claim, ClaimSet, EvidenceBundle } from './sdk.js';

/**
 * Tier-1 projection of a bundle.
 *
 * Three things must not survive the trip: the measured values (`actual`), the
 * raw upstream bodies, and the address. What is left is a set of assertions,
 * the window they cover, and the derivation that produced them — enough for a
 * counterparty to act on, not enough to look the subject up.
 */
export function toClaimSet(bundle: EvidenceBundle): ClaimSet {
  return {
    schema: CLAIMS_SCHEMA,
    referenceId: bundle.referenceId,
    chains: [...bundle.subject.chains],
    window: { from: bundle.window.from, to: bundle.window.to },
    claims: bundle.claims.map(stripActual),
    derivedAt: bundle.derivedAt,
    derivationId: bundle.derivationId,
  };
}

function stripActual(claim: Claim): Claim {
  return {
    id: claim.id,
    statement: claim.statement,
    op: claim.op,
    threshold: claim.threshold,
    unit: claim.unit,
    passed: claim.passed,
    sources: [...claim.sources],
  };
}

/**
 * The public commitment: sha256 over the canonical tier-1 claim set.
 *
 * This is what goes on chain and into the ENS record. Anyone shown a claim set
 * later can recompute it and see they were shown the sealed one.
 */
export function commitmentFor(bundle: EvidenceBundle): string {
  return canonicalDigest(toClaimSet(bundle));
}
