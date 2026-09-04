/**
 * Live smoke test.
 *
 * Hits the real hosts the zero-credential demo depends on, with no mocks, and
 * skips itself when they cannot be reached — an offline laptop should not turn
 * into a red build, and it should certainly not turn into a green one by
 * asserting less.
 */

import { beforeAll, describe, expect, it } from 'vitest';

import { runProbes, summarise } from '../src/core/probes.js';
import type { ProbeResult } from '../src/core/probes.js';

const REACHABILITY_TIMEOUT = 6_000;

async function online(): Promise<boolean> {
  // An explicit opt-out, so a sandboxed CI run can skip the network without
  // waiting for a DNS timeout it already knows the answer to.
  if (process.env['ZEGEL_SKIP_LIVE'] !== undefined) return false;
  try {
    const response = await fetch('https://demo-api.mobula.io/api/2/market/lighthouse', {
      signal: AbortSignal.timeout(REACHABILITY_TIMEOUT),
    });
    return response.ok;
  } catch {
    return false;
  }
}

const reachable = await online();

describe.skipIf(!reachable)('live dependencies', () => {
  let results: ProbeResult[];

  beforeAll(async () => {
    results = await runProbes({ timeoutMs: 10_000 });
  });

  it('reaches the Mobula demo host with no credentials at all', () => {
    const demo = results.find((r) => r.id === 'mobula-demo');
    expect(demo?.status).toBe('ok');
    expect(demo?.detail).toBe('HTTP 200');
  });

  it('reaches the open GraphQL endpoint with no auth header', () => {
    expect(results.find((r) => r.id === 'mobula-graphql')?.status).toBe('ok');
  });

  it('reaches the public Swarm gateway, which is what makes nodeless sealing possible', () => {
    expect(results.find((r) => r.id === 'swarm-gateway')?.status).toBe('ok');
  });

  it('says the gateway is obscurity rather than access control, even when it works', () => {
    expect(results.find((r) => r.id === 'swarm-gateway')?.cost).toContain('obscurity');
  });

  it('reports Mobula production as unconfigured, not as broken, without a key', () => {
    const prod = results.find((r) => r.id === 'mobula-prod');
    if (process.env['MOBULA_API_KEY'] === undefined) {
      expect(prod?.status).toBe('not-configured');
      expect(prod?.latencyMs).toBeNull();
    } else {
      expect(['ok', 'unavailable']).toContain(prod?.status);
    }
  });

  it('reports the local Bee node honestly either way', () => {
    const bee = results.find((r) => r.id === 'bee-node');
    expect(['ok', 'degraded', 'unavailable']).toContain(bee?.status);
    // Whatever is wrong — absent, no publisher key, no postage left — the row has
    // to say what it costs, and every one of those costs lands on grant/revoke.
    if (bee?.status !== 'ok') {
      expect(bee?.cost.length).toBeGreaterThan(0);
      expect(bee?.cost.toLowerCase()).toMatch(/grant|publisher key/);
    }
  });

  it('answers from the ZegelAnchor contract on Base, not merely from an RPC socket', () => {
    const anchor = results.find((r) => r.id === 'anchor-base');
    expect(anchor?.status).toBe('ok');
    expect(anchor?.detail).toContain('verify() returned 1 (valid)');
  });

  it('measures a latency for every probe it actually made', () => {
    for (const result of results) {
      if (result.status === 'not-configured') continue;
      expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    }
  });

  it('finds the zero-credential path available', () => {
    const tally = summarise(results);
    expect(tally.blocking).toEqual([]);
    expect(tally.demoPathReady).toBe(true);
  });
});
