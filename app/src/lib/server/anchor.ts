import 'server-only';

import { verifyAnchor, ZEGEL_ANCHOR_ABI } from '@zegel/sdk';
import type { ClaimSet, SealedEnvelope } from '@zegel/sdk/types';

import { baseClient } from '../chain';
import { ANCHOR_ADDRESS, ANCHOR_CHAIN_ID } from '../config';

export { ZEGEL_ANCHOR_ABI };

export interface AnchorView {
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
}

const asIso = (seconds: bigint): string => new Date(Number(seconds) * 1000).toISOString();

/**
 * What Base mainnet says about this reference, right now.
 *
 * Revocation and expiry are read from the chain rather than inferred from the
 * envelope, because the envelope is public, unauthenticated and cacheable: an
 * issuer who revoked yesterday cannot un-publish the envelope a reader already
 * has, and the anchor is the thing that moves.
 */
export async function readAnchor(
  envelope: SealedEnvelope,
  claims?: ClaimSet,
): Promise<AnchorView> {
  const report =
    claims === undefined
      ? await verifyAnchor(baseClient(), ANCHOR_ADDRESS, envelope)
      : await verifyAnchor(baseClient(), ANCHOR_ADDRESS, envelope, claims);

  return {
    status: report.anchor,
    summary: report.summary,
    contract: ANCHOR_ADDRESS,
    chainId: ANCHOR_CHAIN_ID,
    record:
      report.record === undefined || report.record.anchoredAt === 0n
        ? null
        : {
            commitment: report.record.commitment,
            issuer: report.record.issuer,
            expiresAt: asIso(report.record.expiresAt),
            anchoredAt: asIso(report.record.anchoredAt),
            revokedAt: report.record.revokedAt === 0n ? null : asIso(report.record.revokedAt),
          },
  };
}
