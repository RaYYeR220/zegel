import 'server-only';

import { patchAccess } from './access';
import { parseGranteeKeys, SwarmUnavailableError, toGranteeViews } from './swarm';
import type { StoredTier } from '../types';

interface PatchBody {
  referenceId?: unknown;
  tier?: unknown;
  publicKeys?: unknown;
}

/**
 * The one handler behind both grant and revoke.
 *
 * They are the same operation with the opposite sign, and they share the single
 * property that matters: neither can be faked. `POST /grantee` is 404 on the
 * public Swarm gateway and the ACT publisher private key has to be one we hold,
 * so when the node is missing this refuses and says what is missing rather than
 * reporting a grant that did not happen.
 */
export async function handlePatch(
  request: Request,
  action: 'grant' | 'revoke',
): Promise<Response> {
  const body = (await request.json()) as PatchBody;
  const referenceId = typeof body.referenceId === 'string' ? body.referenceId : null;
  const tier = body.tier as StoredTier | undefined;
  const raw = Array.isArray(body.publicKeys)
    ? body.publicKeys.filter((value): value is string => typeof value === 'string')
    : [];

  if (referenceId === null || tier === undefined) {
    return Response.json({ error: 'referenceId and tier are required' }, { status: 400 });
  }
  if (raw.length === 0) {
    return Response.json({ error: `${action} needs at least one public key` }, { status: 400 });
  }

  let keys: string[];
  try {
    keys = parseGranteeKeys(raw);
  } catch (cause) {
    return Response.json(
      { error: cause instanceof Error ? cause.message : String(cause) },
      { status: 422 },
    );
  }

  try {
    const result = await patchAccess(
      referenceId,
      tier,
      action === 'grant' ? { add: keys } : { revoke: keys },
    );

    return Response.json({
      action,
      tier: result.tier,
      added: toGranteeViews(result.added),
      revoked: toGranteeViews(result.revoked),
      grantees: toGranteeViews(result.grantees),
      previous: result.previous,
      at: result.at,
      warnings: result.warnings,
    });
  } catch (cause) {
    const refused =
      cause instanceof SwarmUnavailableError
        ? `no Bee node at ${cause.url}: ${cause.message}`
        : cause instanceof Error
          ? cause.message
          : String(cause);

    return Response.json(
      {
        error: `${action} was refused, not faked`,
        detail: refused,
        hint:
          'Grantee lists live behind POST /grantee, which the public Swarm gateway answers with 404, ' +
          'and the ACT publisher private key has to belong to a node we run. Start a Bee node and set ZEGEL_BEE_URL.',
      },
      { status: 503 },
    );
  }
}
