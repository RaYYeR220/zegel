import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { buildEvidence, createMobulaClient, type CollectProgress } from '../src/index.js';

/**
 * Records real Mobula responses into `test/fixtures/` so the pure tests run on
 * data the API actually returned rather than on something plausible-looking.
 *
 *   ZEGEL_RECORD=1 pnpm vitest run scripts/fixtures.record.ts
 *
 * Skipped otherwise, because the fixtures are checked in and the unit tests must
 * not depend on the network.
 */

const FIXTURES = fileURLToPath(new URL('../test/fixtures/', import.meta.url));

/** A public, heavily documented address. Real multi-chain trading history. */
const EVM_WALLET = '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045';
/** Surfaced by `/2/token/security` top-trader rankings; 200+ closed cycles. */
const SOLANA_WALLET = 'D9NKx3SkKfJzXENgdPbTDxdvxTM7p6ckxoXmHwkgugVy';

describe.skipIf(process.env['ZEGEL_RECORD'] === undefined)('fixture recording', () => {
  it('records live bundles', { timeout: 600_000 }, async () => {
    mkdirSync(FIXTURES, { recursive: true });
    const client = createMobulaClient();
    const now = new Date();
    const report: CollectProgress[] = [];

    const shared = {
      client,
      now,
      window: { from: '2024-01-01T00:00:00.000Z', to: now.toISOString() },
      historyLimit: 20,
      positionsLimit: 10,
      tradesLimit: 20,
      maxSecurityLookups: 6,
      onProgress: (event: CollectProgress) => report.push(event),
    };

    const evm = await buildEvidence(EVM_WALLET, {
      ...shared,
      chains: ['evm:1', 'evm:8453'],
      referenceId: `0x${'11'.repeat(32)}`,
    });
    const solana = await buildEvidence(SOLANA_WALLET, {
      ...shared,
      chains: ['solana'],
      referenceId: `0x${'22'.repeat(32)}`,
    });

    writeFileSync(`${FIXTURES}bundle-evm.json`, JSON.stringify(evm));
    writeFileSync(`${FIXTURES}bundle-solana.json`, JSON.stringify(solana));
    writeFileSync(
      `${FIXTURES}collection-report.json`,
      JSON.stringify(
        report.map((e) => ({
          endpoint: e.endpoint,
          status: e.status,
          httpStatus: e.httpStatus,
        })),
        null,
        2,
      ),
    );

    expect(evm.sources.length).toBeGreaterThan(0);
    expect(solana.sources.length).toBeGreaterThan(0);
  });
});
