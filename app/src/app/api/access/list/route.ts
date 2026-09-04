import { listAccess } from '~/lib/server/access';
import { SwarmUnavailableError, toGranteeViews } from '~/lib/server/swarm';
import type { AccessLedger, StoredTier } from '~/lib/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<Response> {
  const { referenceId, tier } = (await request.json()) as {
    referenceId?: string;
    tier?: StoredTier;
  };

  if (typeof referenceId !== 'string' || tier === undefined) {
    return Response.json({ error: 'referenceId and tier are required' }, { status: 400 });
  }

  try {
    const { grantees, detail } = await listAccess(referenceId, tier);
    const ledger: AccessLedger = {
      tier: tier.tier,
      grantees: toGranteeViews(grantees),
      available: true,
      detail,
    };
    return Response.json(ledger);
  } catch (cause) {
    const ledger: AccessLedger = {
      tier: tier.tier,
      grantees: [],
      available: false,
      detail:
        cause instanceof SwarmUnavailableError
          ? `no Bee node at ${cause.url}: ${cause.message}. Grant and revoke live behind POST /grantee, which only a node exposes.`
          : cause instanceof Error
            ? cause.message
            : String(cause),
    };
    return Response.json(ledger, { status: 503 });
  }
}
