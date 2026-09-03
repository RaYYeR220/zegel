import { describe, expect, it } from 'vitest';

import {
  DEMO_BASE_URL,
  ENDPOINTS,
  KNOWN_FLAKY,
  buildEvidence,
  createMobulaClient,
  filterTokens,
  tokenTopTraders,
  verifyClaims,
} from '../src/index.js';
import type { Envelope, Paginated, PositionHistoryEntry, TokenSecurity } from '../src/upstream.js';

/**
 * Runs against the real, keyless `demo-api.mobula.io` and the open GraphQL host.
 * Skipped when there is no network, so a plane or a locked-down CI box does not
 * turn into a red build. Everything the derivation depends on is asserted here
 * against live responses, not against a recording.
 */

const WALLET = '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045';
const WSOL = 'So11111111111111111111111111111111111111112';

const online = await reachable();

async function reachable(): Promise<boolean> {
  try {
    const response = await fetch(`${DEMO_BASE_URL}/api${ENDPOINTS.lighthouse}`, {
      signal: AbortSignal.timeout(12_000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

describe.skipIf(!online)('live demo host', () => {
  const client = createMobulaClient();

  it('serves closed position cycles with the fields the derivation reads', async () => {
    const result = await client.get<Paginated<PositionHistoryEntry>>(ENDPOINTS.positionsHistory, {
      wallet: WALLET,
      chainIds: 'evm:1',
      limit: 5,
    });

    expect(result.status).toBe(200);
    expect(Array.isArray(result.body.data)).toBe(true);
    const entry = result.body.data[0];
    expect(entry).toBeDefined();
    for (const field of ['isOpen', 'entryDate', 'exitDate', 'realizedPnlUSD', 'feesUSD'] as const) {
      expect(entry?.cycle).toHaveProperty(field);
    }
    expect(entry?.token.chainId).toBe('evm:1');
  });

  it('reports the credit cost of every response', async () => {
    const before = client.rateLimit.history.length;
    const result = await client.get(ENDPOINTS.labels, { wallet: WALLET });

    expect(result.rateLimit.limit).toBeGreaterThan(0);
    expect(result.rateLimit.cost).not.toBeNull();
    expect(client.rateLimit.history.length).toBe(before + 1);
    expect(client.rateLimit.latest?.endpoint).toBe(`GET ${ENDPOINTS.labels}`);
  });

  it('serves the explainable security score the risk claim is built on', async () => {
    const result = await client.get<Envelope<TokenSecurity>>(ENDPOINTS.tokenSecurity, {
      address: WSOL,
      chainId: 'solana',
    });

    const security = result.body.data;
    expect(typeof security.securityScore).toBe('number');
    expect(security.securityScore).toBeGreaterThanOrEqual(0);
    expect(security.securityScore).toBeLessThanOrEqual(100);

    const checks = security.securityScoreDetails?.checks ?? [];
    expect(checks.length).toBeGreaterThan(0);
    for (const check of checks) {
      expect(typeof check.name).toBe('string');
      expect(check.name.length).toBeGreaterThan(0);
      expect(['penalty', 'bonus']).toContain(check.kind);
    }
  });

  it('serves the global market aggregate', async () => {
    const result = await client.get<Envelope<{ total?: { volumeUSD?: Record<string, number> } }>>(
      ENDPOINTS.lighthouse,
    );
    expect(result.body.data.total?.volumeUSD?.['24h']).toBeGreaterThan(0);
  });

  it('reports the known-flaky routes honestly instead of inventing a value', async () => {
    const observed: { path: string; ok: boolean; status: number | null }[] = [];
    for (const path of KNOWN_FLAKY) {
      const attempt = await client.tryGet(path, { wallet: WALLET });
      observed.push({
        path,
        ok: attempt.ok,
        status: attempt.ok ? attempt.value.status : attempt.error.status,
      });
    }
    // These recover intermittently; what must hold is that a failure surfaces as
    // a typed error carrying its status, never as a fabricated body.
    for (const row of observed) {
      if (row.ok) expect(row.status).toBe(200);
      else expect(row.status === null || row.status >= 400).toBe(true);
    }
  }, 180_000);
});

describe.skipIf(!online)('live GraphQL host', () => {
  const client = createMobulaClient();

  it('answers the screener query with no credentials at all', async () => {
    const rows = await filterTokens(client, 3);
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect(row.token.address).toMatch(/^\S+$/);
      expect(row.volume24).toBeGreaterThan(0);
      expect(row.chain).not.toBeNull();
    }
  });

  it('ranks a token top traders by realized PnL', async () => {
    const rows = await tokenTopTraders(client, {
      tokenAddress: '0xa27ec0006e59f245217ff08cd52a7e8b169e62d2',
      networkId: 1,
      tradingPeriod: 'MONTH',
      limit: 3,
    });
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.wallet).toMatch(/^0x[0-9a-fA-F]{40}$/);
      expect(Number.isFinite(row.realizedProfitUsd)).toBe(true);
      expect(row.chain).toBe('evm:1');
    }
  });
});

describe.skipIf(!online)('live end-to-end', () => {
  it('builds a bundle that verifies against its own sources', async () => {
    const bundle = await buildEvidence(WALLET, {
      chains: ['evm:1'],
      window: { from: '2024-01-01T00:00:00.000Z', to: new Date().toISOString() },
      historyLimit: 10,
      positionsLimit: 5,
      tradesLimit: 10,
      maxSecurityLookups: 2,
      probeOptionalEndpoints: false,
      concurrency: 1,
    });

    expect(bundle.subject.address).toBe(WALLET);
    expect(bundle.sources.length).toBeGreaterThanOrEqual(6);
    expect(bundle.claims.length).toBeGreaterThan(0);

    for (const source of bundle.sources) {
      expect(source.digest).toMatch(/^0x[0-9a-f]{64}$/);
      if (source.unavailable === undefined) expect(source.body).toBeDefined();
      else expect(source.body).toBeUndefined();
    }

    const verification = verifyClaims(bundle);
    expect(verification.mismatches).toEqual([]);
    expect(verification.ok).toBe(true);
  }, 240_000);
});
