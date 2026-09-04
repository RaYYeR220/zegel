import { verifyClaims } from '@zegel/evidence';
import { assertEnvelope, commitmentFor, resolveEnvelope } from '@zegel/sdk';
import type { ClaimSet, EvidenceBundle, SealedEnvelope } from '@zegel/sdk/types';
import { normalize } from 'viem/ens';

import { ethClient } from '~/lib/chain';
import { BEE_READER_URL } from '~/lib/config';
import { byUnit } from '~/lib/format';
import { buildMrz } from '~/lib/mrz';
import { readAnchor } from '~/lib/server/anchor';
import { actRead, readerAvailable } from '~/lib/server/swarm';
import type { ReadOutcome, StoredTier, Verdict, VerifyResult } from '~/lib/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

interface VerifyBody {
  /** Resolve the envelope from an ENS name under ENSIP-24. */
  name?: unknown;
  /** Or hand it over directly — a pasted envelope, or the issuer's own record. */
  envelope?: unknown;
  /**
   * The negative control. When present, this claim set is verified in place of
   * whatever was decrypted: the commitment is recomputed from it and put to the
   * anchor contract on Base. A doctored number does not fail because we noticed
   * it, it fails because the sum does not come out.
   */
  claimSet?: unknown;
  /** Marks the run as a deliberate forgery so the page can label it. */
  tampered?: unknown;
}

export async function POST(request: Request): Promise<Response> {
  const body = (await request.json()) as VerifyBody;
  const at = new Date().toISOString();

  // --- 1. get the envelope ------------------------------------------------
  let envelope: SealedEnvelope | null = null;
  let source: VerifyResult['source'];

  if (typeof body.name === 'string' && body.name.trim() !== '') {
    const name = normalize(body.name.trim());
    source = { kind: 'ens', detail: `ENSIP-24 data(node, "zegel.envelope.v1") on ${name}` };
    try {
      envelope = await resolveEnvelope(ethClient(), name);
    } catch (cause) {
      return Response.json(
        notFound(
          source,
          at,
          `${name} publishes no readable Zegel envelope`,
          cause instanceof Error ? cause.message : String(cause),
        ),
      );
    }
  } else if (body.envelope !== undefined && body.envelope !== null) {
    source = { kind: 'record', detail: 'envelope supplied by the holder' };
    try {
      envelope = assertEnvelope(body.envelope);
    } catch (cause) {
      return Response.json(
        notFound(
          source,
          at,
          'that is not a Zegel envelope',
          cause instanceof Error ? cause.message : String(cause),
        ),
      );
    }
  } else {
    return Response.json({ error: 'give an ENS name or an envelope' }, { status: 400 });
  }

  // --- 2. print the machine-readable zone ---------------------------------
  const mrzTier = envelope.tiers[0]?.tier ?? 1;
  const mrz = buildMrz({
    name: source.kind === 'ens' ? source.detail.split(' on ')[1] ?? null : null,
    referenceId: envelope.referenceId,
    commitment: envelope.commitment,
    recordFrom: envelope.issuedAt,
    expiresAt: envelope.expiresAt,
    tier: mrzTier,
  });

  // --- 3. try to open every tier the envelope points at --------------------
  const reader = await readerAvailable();
  const reads: { tier: 1 | 2; outcome: ReadOutcome }[] = [];
  let openedClaims: ClaimSet | null = null;
  let openedBundle: EvidenceBundle | null = null;

  if (reader.ok) {
    for (const tier of envelope.tiers) {
      const stored: StoredTier = {
        tier: tier.tier,
        swarmRef: tier.swarmRef,
        actHistoryAddress: tier.actHistoryAddress,
        actPublisher: tier.actPublisher,
        sealedAt: envelope.issuedAt,
        bytes: 0,
      };
      const outcome = await actRead(BEE_READER_URL, stored);
      reads.push({ tier: tier.tier, outcome });

      // Sorted by what came back rather than by which tier it was filed under: an
      // object is what its schema says it is, and mis-filing it upstream should
      // not silently produce a verdict about the wrong payload.
      if (outcome.granted) {
        if (outcome.schema === 'zegel.claims.v1') openedClaims = outcome.payload as ClaimSet;
        if (outcome.schema === 'zegel.bundle.v1') openedBundle = outcome.payload as EvidenceBundle;
      }
    }
  }

  // --- 4. the claim set under inspection -----------------------------------
  const supplied = body.claimSet as ClaimSet | undefined;
  const claimSet = supplied ?? openedClaims ?? (openedBundle === null ? null : bundleToClaims(openedBundle));
  const tampered = body.tampered === true;

  const commitment =
    claimSet === null
      ? null
      : {
          expected: envelope.commitment,
          recomputed: commitmentFor(claimSet),
          matches: commitmentFor(claimSet) === envelope.commitment,
        };

  // --- 5. what Base mainnet says ------------------------------------------
  let anchor: VerifyResult['anchor'] = null;
  try {
    anchor = await readAnchor(envelope, claimSet ?? undefined);
  } catch (cause) {
    anchor = {
      status: 'unreadable',
      summary: `the anchor could not be read: ${cause instanceof Error ? cause.message : String(cause)}`,
      contract: envelope.revocationHint.contract,
      chainId: envelope.revocationHint.chainId,
      record: null,
    };
  }

  // --- 6. re-derive from the raw bodies, if we were given them -------------
  const rederivation = openedBundle === null ? null : rederive(openedBundle);

  // --- 7. the verdict ------------------------------------------------------
  const expired = Date.parse(envelope.expiresAt) < Date.now();
  const verdict = decide({
    anchorStatus: anchor?.status ?? 'unreadable',
    commitmentMatches: commitment?.matches ?? null,
    rederivationOk: rederivation === null ? null : rederivation.ok,
    expired,
    anyRead: reads.some((read) => read.outcome.granted),
    readerUp: reader.ok,
  });

  const result: VerifyResult = {
    source,
    envelope,
    mrz: { line1: mrz.line1, line2: mrz.line2 },
    anchor,
    reads,
    claimSet: claimSet ?? null,
    commitment,
    rederivation,
    verdict,
    headline: HEADLINES[verdict],
    detail: explain(verdict, {
      anchor,
      commitment,
      rederivation,
      readerUp: reader.ok,
      readerDetail: reader.detail,
      tampered,
    }),
    at,
  };

  return Response.json(result);
}

// ---------------------------------------------------------------------------

const HEADLINES: Record<Verdict, string> = {
  valid: 'Geldig / Valid',
  expired: 'Verlopen / Expired',
  revoked: 'Ingetrokken / Revoked',
  tampered: 'Geweigerd / Refused',
  'not-granted': 'Geen toegang / Not granted',
  'not-found': 'Geen record / Not on file',
};

function decide(input: {
  anchorStatus: string;
  commitmentMatches: boolean | null;
  rederivationOk: boolean | null;
  expired: boolean;
  anyRead: boolean;
  readerUp: boolean;
}): Verdict {
  // A forgery is a forgery whatever else is wrong with it, so it is decided first.
  if (input.commitmentMatches === false) return 'tampered';
  if (input.anchorStatus === 'commitment-mismatch') return 'tampered';
  if (input.rederivationOk === false) return 'tampered';
  if (input.anchorStatus === 'revoked') return 'revoked';
  if (input.anchorStatus === 'never-anchored') return 'not-found';
  if (input.anchorStatus === 'expired' || input.expired) return 'expired';
  if (input.readerUp && !input.anyRead) return 'not-granted';
  return 'valid';
}

function explain(
  verdict: Verdict,
  context: {
    anchor: VerifyResult['anchor'];
    commitment: VerifyResult['commitment'];
    rederivation: VerifyResult['rederivation'];
    readerUp: boolean;
    readerDetail: string;
    tampered: boolean;
  },
): string {
  switch (verdict) {
    case 'tampered':
      return context.commitment?.matches === false
        ? `The claim set in front of you hashes to ${context.commitment.recomputed}. The envelope, and the anchor on Base, ` +
            `commit to ${context.commitment.expected}. Nobody recognised the forgery — the sum simply does not come out.`
        : 'Re-deriving the claims from the raw upstream bodies does not reproduce what was declared. The numbers disagree with their own evidence.';
    case 'revoked':
      return `${context.anchor?.summary ?? ''} Revocation is observable on chain without decrypting anything, which is the point: a reader can be cut off without being told what they were cut off from.`;
    case 'expired':
      return 'Nobody withdrew anything. The expiry date did the work, exactly as it should for a reference that was never meant to last forever.';
    case 'not-granted':
      return 'Every sealed tier answered 404. That is the same answer Swarm gives for an object that never existed — no error code, no trace, nothing to infer from.';
    case 'not-found':
      return 'No reference has ever been anchored under this id on Base. The line may be printed correctly; there is simply nothing to hold it against.';
    case 'valid':
    default:
      return context.readerUp
        ? 'The commitment matches the sealed claim set, the anchor on Base is live, and the reader opened what it was granted.'
        : `The commitment and the anchor check out. Nothing here could open a sealed tier, because ${context.readerDetail} — so this is a verdict on the public half only.`;
  }
}

function notFound(
  source: VerifyResult['source'],
  at: string,
  headline: string,
  detail: string,
): VerifyResult {
  return {
    source,
    envelope: null,
    mrz: null,
    anchor: null,
    reads: [],
    claimSet: null,
    commitment: null,
    rederivation: null,
    verdict: 'not-found',
    headline: `${HEADLINES['not-found']} — ${headline}`,
    detail,
    at,
  };
}

/** A tier-2 grantee holds the bundle; its tier-1 projection is what the commitment covers. */
function bundleToClaims(bundle: EvidenceBundle): ClaimSet {
  return {
    schema: 'zegel.claims.v1',
    referenceId: bundle.referenceId,
    chains: [...bundle.subject.chains],
    window: { from: bundle.window.from, to: bundle.window.to },
    claims: bundle.claims.map((claim) => ({
      id: claim.id,
      statement: claim.statement,
      op: claim.op,
      threshold: claim.threshold,
      unit: claim.unit,
      passed: claim.passed,
      sources: [...claim.sources],
    })),
    derivedAt: bundle.derivedAt,
    derivationId: bundle.derivationId,
  };
}

/**
 * The re-derivation.
 *
 * A tier-2 grantee does not have to believe the issuer: they run the same pure
 * function over the same recorded upstream bodies and compare. This is that run,
 * and its per-claim comparison is what the inspection desk prints.
 */
function rederive(bundle: EvidenceBundle): NonNullable<VerifyResult['rederivation']> {
  const result = verifyClaims(bundle);
  const recomputed = new Map(result.recomputed.map((claim) => [claim.id, claim]));

  const comparisons = bundle.claims.map((claim) => {
    const mine = recomputed.get(claim.id);
    const declared = claim.actual === undefined ? (claim.passed ? 'gedekt' : 'niet gedekt') : byUnit(claim.actual, claim.unit);
    const rederived =
      mine === undefined
        ? 'niet afleidbaar'
        : mine.actual === undefined
          ? mine.passed
            ? 'gedekt'
            : 'niet gedekt'
          : byUnit(mine.actual, mine.unit);
    return {
      id: claim.id,
      statement: claim.statement,
      declared,
      rederived,
      agrees: mine !== undefined && mine.passed === claim.passed && mine.actual === claim.actual,
    };
  });

  return { ran: true, ok: result.ok, mismatches: result.mismatches, comparisons };
}
