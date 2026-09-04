import { commitmentFor, controlProofMessage, toClaimSet, verifyClaims } from '@zegel/evidence';
import { isReadable, toSealedTier } from '@zegel/seal';
import { ENVELOPE_SCHEMA, type SealedEnvelope, type SealedTier } from '@zegel/sdk/types';
import { getAddress, isAddress, verifyMessage } from 'viem';

import { ANCHOR_ADDRESS, ANCHOR_CHAIN_ID, DEFAULT_EXPIRY_DAYS } from '~/lib/config';
import { ndjsonStream } from '~/lib/ndjson';
import { collect, meter, missingClaims, mobula } from '~/lib/server/evidence';
import { primaryName } from '~/lib/server/subject';
import {
  parseGranteeKeys,
  publisherClient,
  storedFrom,
  SwarmUnavailableError,
} from '~/lib/server/swarm';
import type { ReferenceRecord, SealOutcome, StoredTier } from '~/lib/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

interface IssueBody {
  address?: unknown;
  referenceId?: unknown;
  signature?: unknown;
  grantees?: unknown;
  expiresDays?: unknown;
}

/**
 * Issue a reference.
 *
 * The signature check at the top is the whole constraint: a reference can only
 * ever be issued for a wallet whose control has been proven in this request, by
 * this browser, to this endpoint. There is no operator override and no "trusted
 * issuer" path, because a reference somebody else can mint about your wallet is
 * not a reference, it is a rumour with a hash on it.
 */
export async function POST(request: Request): Promise<Response> {
  const body = (await request.json()) as IssueBody;

  const address = typeof body.address === 'string' ? body.address : '';
  const referenceId = typeof body.referenceId === 'string' ? body.referenceId : '';
  const signature = typeof body.signature === 'string' ? body.signature : '';
  const requestedGrantees = Array.isArray(body.grantees)
    ? body.grantees.filter((value): value is string => typeof value === 'string')
    : [];
  const expiresDays =
    typeof body.expiresDays === 'number' && Number.isFinite(body.expiresDays) && body.expiresDays > 0
      ? Math.min(Math.round(body.expiresDays), 365)
      : DEFAULT_EXPIRY_DAYS;

  if (!isAddress(address)) {
    return Response.json({ error: 'issuing needs the subject wallet address' }, { status: 400 });
  }
  if (!/^0x[0-9a-fA-F]{64}$/.test(referenceId)) {
    return Response.json({ error: 'referenceId must be 32 bytes of hex' }, { status: 400 });
  }

  const message = controlProofMessage(referenceId);
  const subjectAddress = getAddress(address);

  let proven = false;
  try {
    proven = await verifyMessage({ address: subjectAddress, message, signature: signature as `0x${string}` });
  } catch {
    proven = false;
  }

  if (!proven) {
    return Response.json(
      {
        error: 'no valid control proof for this wallet',
        detail:
          `Issuing requires an EIP-191 signature over "${message}" from ${subjectAddress} itself. ` +
          'Without it there is nothing separating a reference about your wallet from a reference about anyone ' +
          "else's, which is why this is refused rather than degraded.",
      },
      { status: 403 },
    );
  }

  let grantees: string[];
  try {
    grantees = parseGranteeKeys(requestedGrantees);
  } catch (cause) {
    return Response.json(
      { error: cause instanceof Error ? cause.message : String(cause) },
      { status: 422 },
    );
  }

  return ndjsonStream(async (sink) => {
    sink.send({ type: 'proof', signer: subjectAddress, message });

    const ensName = await primaryName(subjectAddress);
    sink.send({ type: 'name', ensName });

    const client = mobula();
    sink.send({ type: 'source', host: client.baseUrl, keyed: client.hasApiKey });

    const stopMeter = client.rateLimit.subscribe((snapshot) => {
      sink.send({ type: 'credits', snapshot, spent: client.rateLimit.spent });
    });

    let bundle;
    try {
      bundle = await collect(client, subjectAddress, {
        referenceId,
        controlProof: { message, signature, signer: subjectAddress },
        onProgress: (event) => {
          sink.send({ type: 'progress', ...event });
        },
      });
    } finally {
      stopMeter();
    }

    const claimSet = toClaimSet(bundle);
    const commitment = commitmentFor(bundle);
    const control = verifyClaims(bundle);

    sink.send({
      type: 'claims',
      claims: bundle.claims,
      claimSet,
      commitment,
      derivationId: bundle.derivationId,
      window: bundle.window,
      missing: missingClaims(bundle),
      negativeControl: { ok: control.ok, mismatches: control.mismatches },
      credits: meter(client),
    });

    // --- sealing ---------------------------------------------------------
    const warnings: string[] = [];
    const seal: SealOutcome = {
      attempted: true,
      backend: null,
      tiers: [],
      unpublishable: 0,
      error: null,
    };
    const stored: StoredTier[] = [];

    try {
      const swarm = await publisherClient(warnings);
      seal.backend = {
        kind: swarm.caps.kind,
        url: swarm.caps.url,
        confidentiality: swarm.caps.confidentiality,
        canManageGrantees: swarm.caps.canManageGrantees,
        limitations: swarm.caps.limitations,
      };
      sink.send({ type: 'backend', backend: seal.backend, warnings });

      // A grantee list only comes into existence when the seal is given at least
      // one key, and grant/revoke can only patch a list that exists. Seeding it
      // with the publisher's own key costs nothing — the publisher can already
      // read — and it is the difference between a reference that can be shared
      // later and one that is frozen at issue time.
      const seeded = grantees.length > 0 || swarm.publisher === null
        ? grantees
        : [swarm.publisher];
      if (seeded !== grantees) {
        sink.send({
          type: 'note',
          message:
            'No reader keys were given, so the grantee list was opened with the publisher key alone. ' +
            'The list has to exist before anyone can be added to it.',
        });
      }

      const tiers: SealedTier[] = [];
      for (const [tier, payload] of [
        [1, claimSet],
        [2, bundle],
      ] as const) {
        sink.send({ type: 'sealing', tier });
        const receipt = await swarm.seal(payload, seeded, { referenceId, tier });

        if (isReadable(receipt)) {
          tiers.push(toSealedTier(receipt));
          stored.push(storedFrom(receipt));
          sink.send({
            type: 'sealed',
            tier,
            swarmRef: receipt.swarmRef,
            actHistoryAddress: receipt.actHistoryAddress,
            bytes: receipt.bytes,
          });
        } else {
          seal.unpublishable += 1;
          sink.send({
            type: 'unpublishable',
            tier,
            swarmRef: receipt.swarmRef,
            actHistoryAddress: receipt.actHistoryAddress,
            detail: `${swarm.caps.url} does not expose its ACT publisher key, so no reader could open this tier`,
          });
        }
      }
      seal.tiers = tiers;
    } catch (cause) {
      seal.error =
        cause instanceof SwarmUnavailableError
          ? `no Bee node at ${cause.url}: ${cause.message}`
          : cause instanceof Error
            ? cause.message
            : String(cause);
      sink.send({ type: 'sealFailed', error: seal.error });
    }

    // --- the public envelope ---------------------------------------------
    const issuedAt = new Date();
    const expiresAt = new Date(issuedAt.getTime() + expiresDays * 86_400_000);
    const envelope: SealedEnvelope = {
      schema: ENVELOPE_SCHEMA,
      referenceId,
      commitment,
      issuedAt: issuedAt.toISOString(),
      expiresAt: expiresAt.toISOString(),
      tiers: seal.tiers,
      anchors: {},
      revocationHint: { contract: ANCHOR_ADDRESS, chainId: ANCHOR_CHAIN_ID },
    };

    const record: ReferenceRecord | null =
      stored.length === 0
        ? null
        : {
            referenceId,
            commitment,
            issuedAt: envelope.issuedAt,
            expiresAt: envelope.expiresAt,
            subjectAddress,
            ensName,
            window: bundle.window,
            tiers: stored,
            envelope,
            claimSet,
            anchor: null,
          };

    sink.send({ type: 'issued', envelope, seal, record, credits: meter(client) });
  });
}
