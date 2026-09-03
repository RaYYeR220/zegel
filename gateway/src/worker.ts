import type { Hex } from 'viem';

import { createGatewayApp } from './app.ts';
import { loadConfig } from './config.ts';
import { parseEnvelope } from './envelope.ts';
import { MemoryEnvelopeStore } from './store/memory.ts';
import type { EnvelopeRecord } from './store/types.ts';

type Env = Record<string, string | undefined>;

interface SeedEntry {
  node: Hex;
  name?: string;
  envelope: string;
}

let cached: { env: Env; fetch: (request: Request) => Response | Promise<Response> } | undefined;

/**
 * Cloudflare Workers entry point.
 *
 * There is no filesystem here, so the store is in-memory and seeded from
 * `ZEGEL_ENVELOPES` — a JSON array of `{ node, name?, envelope }`. That is enough
 * for a name whose envelope changes rarely, and `/health` reports the backend as
 * lossy-on-restart so nobody mistakes it for durable storage. Anything longer-lived
 * wants KV or D1 behind the same `EnvelopeStore` interface.
 */
export default {
  fetch(request: Request, env: Env): Response | Promise<Response> {
    if (!cached || cached.env !== env) {
      const store = new MemoryEnvelopeStore(seedRecords(env['ZEGEL_ENVELOPES']));
      const app = createGatewayApp(loadConfig({ env, store }));
      cached = { env, fetch: app.fetch };
    }
    return cached.fetch(request);
  },
};

function seedRecords(raw: string | undefined): EnvelopeRecord[] {
  if (!raw) return [];

  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) throw new Error('ZEGEL_ENVELOPES must be a JSON array');

  return (parsed as SeedEntry[]).map((entry) => ({
    node: entry.node.toLowerCase() as Hex,
    name: entry.name ?? null,
    envelope: parseEnvelope(entry.envelope),
    publishedAt: new Date().toISOString(),
    // Seeded by the deployment rather than by a signed publish, so there is no
    // publisher to name. A later signed publish (nonce >= 1) replaces it.
    publisher: '0x0000000000000000000000000000000000000000',
    nonce: 0n,
  }));
}
