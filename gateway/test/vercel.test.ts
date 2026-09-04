import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { HealthReport } from '../src/health.ts';

import { envelopeText } from './helpers.ts';

const FEED_OWNER = '0x1d755b42e1f483CD6812f76CA63Ae903a18074b8';

let handler: (request: Request) => Response | Promise<Response>;
const realFetch = globalThis.fetch;

/**
 * The Vercel entry point, booted the way Vercel boots it: from environment variables
 * alone, at module load, with no filesystem and no arguments.
 */
beforeAll(async () => {
  // A Bee that answers everything, so the module can construct its feed store without
  // reaching the network during a unit run.
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith('/health')) return new Response('OK', { status: 200 });
    if (url.includes('/feeds/')) {
      return new Response(envelopeText(), {
        status: 200,
        headers: { 'swarm-feed-index': '0000000000000001' },
      });
    }
    return new Response(null, { status: 404 });
  }) as typeof globalThis.fetch;

  process.env['ZEGEL_STORE'] = 'swarm-feed';
  process.env['ZEGEL_FEED_OWNER'] = FEED_OWNER;
  process.env['ZEGEL_BEE_URL'] = 'https://bee.test';
  process.env['ZEGEL_SIGNER_KEY'] =
    '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
  process.env['ZEGEL_RESOLVERS'] = '0x8464135c8F25Da09e49BC8782676a84730C318bC';

  const entry = (await import('../api/[[...route]].ts')) as {
    default: (request: Request) => Response | Promise<Response>;
  };
  handler = entry.default;
});

afterAll(() => {
  globalThis.fetch = realFetch;
});

describe('the Vercel entry point', () => {
  it('boots from environment variables with no filesystem and no state', async () => {
    const response = await handler(new Request('https://gw.test/health'));
    const report = (await response.json()) as HealthReport;

    expect(response.status).toBe(200);
    expect(report.checks.find((check) => check.name === 'store')?.detail).toContain('Swarm feed');
  });

  /**
   * `vercel.json` rewrites every path into `/api/…`. Whether the function then sees
   * the original path or the rewritten one is platform behaviour, and the URL that
   * would be wrong is already published in the resolver's on-chain `gatewayUrls()`.
   * Both spellings are mounted so it cannot matter.
   */
  it('answers on the clean path and on the rewritten /api path alike', async () => {
    const clean = await handler(new Request('https://gw.test/health'));
    const rewritten = await handler(new Request('https://gw.test/api/health'));

    expect(clean.status).toBe(200);
    expect(rewritten.status).toBe(200);
    expect((await rewritten.json()) as HealthReport).toMatchObject({
      service: 'zegel-gateway',
    });
  });

  it('serves CORS on both, since a browser wallet fails silently without it', async () => {
    for (const path of ['/health', '/api/health']) {
      const response = await handler(
        new Request(`https://gw.test${path}`, { headers: { Origin: 'https://app.ens.domains' } }),
      );
      expect(response.headers.get('access-control-allow-origin')).toBe('*');
    }
  });
});
