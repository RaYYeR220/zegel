import { BEE_READER_URL, BEE_URL } from '~/lib/config';
import { actRead, readerAvailable } from '~/lib/server/swarm';
import type { ReadReport, StoredTier } from '~/lib/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * The same object, asked for from three positions at once.
 *
 *   1. the grantee's own node, with the ACT credentials — what a reader gets
 *   2. the same node, with no credentials at all — what the world gets
 *   3. the publisher's node — proof the bytes are still there and intact
 *
 * The third request is why the demo is honest rather than theatrical: without it,
 * a 404 at the grantee could be an object that quietly vanished. With it, the
 * failure is unambiguously *access* and not absence. Every answer carries the
 * upstream's own status and message verbatim, including the difference between
 * `Not Found` and `act or history entry not found` — a real side channel for
 * anyone holding the history address, which we state rather than smooth over.
 */
export async function POST(request: Request): Promise<Response> {
  const { tier } = (await request.json()) as { tier?: StoredTier };
  if (tier === undefined) {
    return Response.json({ error: 'tier coordinates are required' }, { status: 400 });
  }

  const reader = await readerAvailable();

  const [readerOutcome, anonymous, publisher] = await Promise.all([
    reader.ok ? actRead(BEE_READER_URL, tier) : Promise.resolve(null),
    actRead(BEE_URL, tier, { withCredentials: false }),
    actRead(BEE_URL, tier),
  ]);

  const report: ReadReport = {
    reader: readerOutcome ?? { unavailable: true, detail: reader.detail },
    anonymous,
    publisher,
    at: new Date().toISOString(),
  };

  return Response.json(report);
}
