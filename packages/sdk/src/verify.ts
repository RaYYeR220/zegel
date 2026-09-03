import { parseAbi, type Address, type Hex, type PublicClient } from 'viem';
import { canonicalDigest, digestsEqual } from './canonical.js';
import type { ClaimSet, SealedEnvelope } from './types.js';

export const ZEGEL_ANCHOR_ABI = parseAbi([
  'function verify(bytes32 referenceId, bytes32 commitment) view returns (uint8)',
  'function isValid(bytes32 referenceId) view returns (bool)',
  'function issuerOf(bytes32 referenceId) view returns (address)',
  'function getAnchor(bytes32 referenceId) view returns ((bytes32 commitment, address issuer, uint64 expiresAt, uint64 anchoredAt, uint64 revokedAt))',
]);

/** Mirrors `ZegelAnchor.Status`. Order is consensus with the contract — do not reorder. */
export const ANCHOR_STATUS = [
  'never-anchored',
  'valid',
  'expired',
  'revoked',
  'commitment-mismatch',
] as const;

export type AnchorStatus = (typeof ANCHOR_STATUS)[number];

export interface AnchorRecord {
  commitment: Hex;
  issuer: Address;
  expiresAt: bigint;
  anchoredAt: bigint;
  revokedAt: bigint;
}

export interface VerificationReport {
  /** What the on-chain anchor says about this reference right now. */
  anchor: AnchorStatus;
  /** Whether the envelope's commitment matches the claim set we were shown. */
  commitmentMatches: boolean | null;
  /** True only when every check passed. */
  ok: boolean;
  /** Human-readable, one line, safe to render directly. */
  summary: string;
  record?: AnchorRecord;
}

/**
 * Check a reference against its on-chain anchor.
 *
 * Two independent things can go wrong and they mean different things to a reader:
 * the issuer may have revoked or let the reference expire, or the claim set in front
 * of you may not be the one that was sealed. The second case is the negative control —
 * it is what a tampered claim set produces against a live anchor — so it gets its own
 * status rather than collapsing into a generic failure.
 */
export async function verifyAnchor(
  client: PublicClient,
  anchorAddress: Address,
  envelope: SealedEnvelope,
  claims?: ClaimSet,
): Promise<VerificationReport> {
  const referenceId = envelope.referenceId as Hex;

  // When we hold the claim set, verify against what it actually hashes to rather than
  // against the commitment the envelope claims — otherwise a doctored envelope would
  // vouch for its own doctored claims.
  const commitment = (claims ? canonicalDigest(claims) : envelope.commitment) as Hex;

  const [statusIndex, record] = await Promise.all([
    client.readContract({
      address: anchorAddress,
      abi: ZEGEL_ANCHOR_ABI,
      functionName: 'verify',
      args: [referenceId, commitment],
    }),
    client
      .readContract({
        address: anchorAddress,
        abi: ZEGEL_ANCHOR_ABI,
        functionName: 'getAnchor',
        args: [referenceId],
      })
      .catch(() => undefined),
  ]);

  const anchor = ANCHOR_STATUS[Number(statusIndex)] ?? 'never-anchored';

  const commitmentMatches = claims
    ? digestsEqual(canonicalDigest(claims), envelope.commitment)
    : null;

  const ok = anchor === 'valid' && commitmentMatches !== false;

  return {
    anchor,
    commitmentMatches,
    ok,
    summary: summarise(anchor, commitmentMatches),
    ...(record ? { record: record as AnchorRecord } : {}),
  };
}

function summarise(anchor: AnchorStatus, commitmentMatches: boolean | null): string {
  switch (anchor) {
    case 'never-anchored':
      return 'No reference has ever been anchored under this id.';
    case 'expired':
      return 'This reference has expired. The issuer did not renew it.';
    case 'revoked':
      return 'The issuer revoked this reference.';
    case 'commitment-mismatch':
      return 'These claims are not the claims that were sealed. Do not rely on them.';
    case 'valid':
      return commitmentMatches === false
        ? 'The envelope points at a live anchor, but the claims shown do not match its own commitment.'
        : 'Valid. The claims match what the issuer sealed, and the reference is neither expired nor revoked.';
  }
}

/**
 * Recompute an envelope's commitment from a claim set.
 *
 * A verifier should run this before trusting anything rendered from `claims`: the
 * envelope is public and unauthenticated on its own, so the binding that matters is
 * claims -> commitment -> anchor.
 */
export function commitmentFor(claims: ClaimSet): string {
  return canonicalDigest(claims);
}
