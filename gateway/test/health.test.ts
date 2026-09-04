import type { Hex } from 'viem';
import { describe, expect, it } from 'vitest';

import { createGatewayApp } from '../src/app.ts';
import { staticOwners } from '../src/owner.ts';
import type { EnvelopeRecord, EnvelopeStore, StoreProbe } from '../src/store/types.ts';
import type { HealthCheck, HealthReport } from '../src/health.ts';

import { makeConfig } from './helpers.ts';

/** A store that is reachable enough to answer and broken enough to be useless. */
class BrokenStore implements EnvelopeStore {
  readonly kind = 'file';
  readonly writable = true;
  readonly description = 'JSON file at /nowhere/envelopes.json';

  async get(_node: Hex): Promise<EnvelopeRecord | undefined> {
    return undefined;
  }
  async put(): Promise<void> {}
  async list(): Promise<readonly EnvelopeRecord[]> {
    return [];
  }
  async lastNonce(): Promise<bigint> {
    return 0n;
  }
  async probe(): Promise<StoreProbe> {
    return {
      ok: false,
      detail: 'JSON file at /nowhere/envelopes.json: EACCES: permission denied',
      records: 0,
      latencyMs: 1,
    };
  }
}

async function health(config = makeConfig()): Promise<{ status: number; body: HealthReport }> {
  const response = await createGatewayApp(config).request('/health');
  return { status: response.status, body: (await response.json()) as HealthReport };
}

function check(report: HealthReport, name: string): HealthCheck {
  const found = report.checks.find((entry) => entry.name === name);
  if (!found) throw new Error(`no ${name} check in the report`);
  return found;
}

describe('GET /health', () => {
  it('reports ok when every configured dependency answers', async () => {
    const { status, body } = await health();

    expect(status).toBe(200);
    expect(body.status).toBe('ok');
    expect(check(body, 'store').status).toBe('ok');
    expect(check(body, 'signer').detail).toContain(body.signer);
  });

  /** An unconfigured dependency is never reported as passing. */
  it('reports the on-chain check as skipped when there is no RPC, not as ok', async () => {
    const { body } = await health();
    const onchain = check(body, 'resolver-onchain');

    expect(onchain.status).toBe('skipped');
    expect(onchain.detail).toContain('ZEGEL_RPC_URL');
  });

  it('goes down, and 503s, when the store cannot be read', async () => {
    const { status, body } = await health(makeConfig({ store: new BrokenStore() }));

    expect(status).toBe(503);
    expect(body.status).toBe('down');
    expect(check(body, 'store').status).toBe('down');
    // The detail has to be specific enough to act on without reading the logs.
    expect(check(body, 'store').detail).toContain('permission denied');
  });

  it('degrades when the signing key was generated at boot', async () => {
    const { status, body } = await health(makeConfig({ ephemeralSigner: true }));

    expect(status).toBe(200);
    expect(body.status).toBe('degraded');
    expect(check(body, 'signer').status).toBe('degraded');
    expect(check(body, 'signer').detail).toContain('no deployed resolver allowlists it');
  });

  it('degrades when it will sign for any resolver that asks', async () => {
    const { body } = await health(makeConfig({ resolvers: [] }));

    expect(body.status).toBe('degraded');
    expect(check(body, 'resolver-allowlist').status).toBe('degraded');
  });

  it('degrades when no owner source is configured, since publishing is impossible', async () => {
    const { body } = await health(makeConfig({ owners: staticOwners([]) }));

    expect(body.status).toBe('degraded');
    expect(check(body, 'name-ownership').status).toBe('degraded');
    expect(check(body, 'name-ownership').detail).toContain('Publishing is refused');
  });

  it('carries the boot warnings through, verbatim', async () => {
    const { body } = await health(makeConfig({ warnings: ['store path is on a tmpfs'] }));
    expect(body.warnings).toEqual(['store path is on a tmpfs']);
  });

  it('is never cached', async () => {
    const response = await createGatewayApp(makeConfig()).request('/health');
    expect(response.headers.get('cache-control')).toBe('no-store');
  });
});
