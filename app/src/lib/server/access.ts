import 'server-only';

import { coordinatesOf, type SealClient } from '@zegel/seal';

import type { StoredTier } from '../types';
import { publisherClient, receiptFrom, storedFrom } from './swarm';

export interface PatchResult {
  /** The tier as it now stands: new reference, new history, new grantee list. */
  tier: StoredTier;
  added: readonly string[];
  revoked: readonly string[];
  /** Everything on the list after the patch, read back from the node. */
  grantees: readonly string[];
  previous: { swarmRef: string; actHistoryAddress: string };
  at: string;
  warnings: readonly string[];
}

/**
 * Change who can read, then write the content again under the new list.
 *
 * The second half is not an optimisation, it is the mechanism. Patching an ACT
 * grantee list produces a *new* history; the bytes already on Swarm stay attached
 * to the old one and stay readable by the old list. Only content written under
 * the new history reflects the change — which is why revocation here is honestly
 * forward-only, and why a grant does not retroactively open anything either.
 *
 * The payload is fetched back from Swarm as the publisher rather than round-
 * tripped through the browser: a tier-2 bundle is megabytes of raw upstream
 * bodies, and the issuer should not have to re-upload their own evidence to
 * change a reader.
 */
export async function patchAccess(
  referenceId: string,
  stored: StoredTier,
  changes: { add?: readonly string[]; revoke?: readonly string[] },
): Promise<PatchResult> {
  const warnings: string[] = [];
  const client = await publisherClient(warnings);
  const receipt = receiptFrom(stored, referenceId, client);

  if (receipt.granteeListRef === undefined) {
    throw new Error(
      'this tier was sealed without a grantee list, so there is nothing to patch. ' +
        'A list is created at seal time and cannot be added afterwards; re-issue the reference to get one.',
    );
  }

  const patch = await client.patchGrantees(receipt, {
    ...(changes.add === undefined ? {} : { add: changes.add }),
    ...(changes.revoke === undefined ? {} : { revoke: changes.revoke }),
  });

  const payload = await currentPayload(client, receipt);

  const resealed = await client.reseal(
    { ...receipt, granteeListRef: patch.granteeListRef },
    payload,
    { actHistoryAddress: patch.actHistoryAddress },
  );

  const after = await client.listGrantees({
    ...resealed,
    granteeListRef: patch.granteeListRef,
  });

  return {
    tier: storedFrom({ ...resealed, granteeListRef: patch.granteeListRef }),
    added: patch.added,
    revoked: patch.revoked,
    grantees: after ?? [],
    previous: { swarmRef: stored.swarmRef, actHistoryAddress: stored.actHistoryAddress },
    at: patch.at,
    warnings,
  };
}

/** Reads the live grantee list. Only the publisher can decrypt it; anyone else gets 404. */
export async function listAccess(
  referenceId: string,
  stored: StoredTier,
): Promise<{ grantees: readonly string[]; detail: string }> {
  const client = await publisherClient();
  const receipt = receiptFrom(stored, referenceId, client);
  const grantees = await client.listGrantees(receipt);

  return grantees === null
    ? {
        grantees: [],
        detail:
          'the node answered 404 for this grantee list — either it was never created, or this node is not its publisher',
      }
    : {
        grantees,
        detail: `read back from ${client.caps.url} — this is the node's own list, not anything we stored`,
      };
}

async function currentPayload(client: SealClient, receipt: ReturnType<typeof receiptFrom>): Promise<unknown> {
  const opened = await client.unsealEnvelope<unknown>(coordinatesOf(receipt));
  if (!opened.granted) {
    throw new Error(
      'the publisher node could not open its own sealed object, so there is nothing to write again. ' +
        'The stored ACT coordinates and this node do not agree.',
    );
  }
  return opened.envelope.payload;
}
