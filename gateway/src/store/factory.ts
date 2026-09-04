import { getAddress, isAddress } from 'viem';

import { ENVELOPE_SCHEMA } from '../../../packages/sdk/src/types.ts';

import { MemoryEnvelopeStore } from './memory.ts';
import { DEFAULT_BEE_URL, SwarmFeedEnvelopeStore } from './swarm-feed.ts';
import type { EnvelopeStore } from './types.ts';

export type StoreKind = 'memory' | 'file' | 'swarm-feed';

/**
 * Every store that does not need a filesystem.
 *
 * Split from the file-backed one so a serverless entry point — Vercel, a Worker —
 * never pulls `node:fs` into its module graph, and so choosing `file` where there is
 * no durable disk fails at boot with a sentence explaining it rather than silently
 * losing every publish at the next cold start.
 */
export function createStatelessStore(env: Record<string, string | undefined>): EnvelopeStore {
  const kind = (env['ZEGEL_STORE'] ?? 'swarm-feed') as StoreKind;

  if (kind === 'memory') return new MemoryEnvelopeStore();

  if (kind === 'file') {
    throw new Error(
      'ZEGEL_STORE=file needs a durable filesystem, which a serverless deployment does not have. ' +
        'Use ZEGEL_STORE=swarm-feed, which keeps no state at all.',
    );
  }

  if (kind !== 'swarm-feed') {
    throw new Error(`ZEGEL_STORE=${kind} is not one of memory, file, swarm-feed`);
  }

  const owner = env['ZEGEL_FEED_OWNER'];
  if (!owner || !isAddress(owner)) {
    throw new Error('ZEGEL_STORE=swarm-feed needs ZEGEL_FEED_OWNER set to the feed owner address');
  }

  return new SwarmFeedEnvelopeStore({
    beeUrl: env['ZEGEL_BEE_URL'] ?? DEFAULT_BEE_URL,
    owner: getAddress(owner),
    dataKey: env['ZEGEL_ENVELOPE_KEY'] ?? ENVELOPE_SCHEMA,
    ...(env['ZEGEL_FEED_CACHE_TTL'] ? { cacheTtlSeconds: Number(env['ZEGEL_FEED_CACHE_TTL']) } : {}),
  });
}
