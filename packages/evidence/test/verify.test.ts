import { describe, expect, it } from 'vitest';

import { deriveClaims } from '../src/derive.js';
import { canonicalDigest } from '../src/sdk.js';
import type { EvidenceBundle } from '../src/sdk.js';
import { verifyClaims } from '../src/verify.js';
import { BUNDLE_NAMES, loadBundle } from './helpers.js';

/**
 * The negative control. A reference is only worth anything if a doctored one
 * fails, so these tests are the ones that matter most in this package.
 */
describe('verifyClaims', () => {
  it.each(BUNDLE_NAMES)('accepts the untouched %s', (name) => {
    const result = verifyClaims(loadBundle(name));
    expect(result.mismatches).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it('rejects a bundle whose derivationId is not the current derivation', () => {
    const bundle = loadBundle('bundle-evm');
    const result = verifyClaims({ ...bundle, derivationId: `0x${'ab'.repeat(32)}` });
    expect(result.ok).toBe(false);
    expect(result.mismatches).toHaveLength(1);
    expect(result.mismatches[0]).toMatch(/^derivationId:/);
    // Rejected outright rather than re-scored under rules it was not built with.
    expect(result.recomputed).toEqual([]);
  });

  it('catches one nudged number in one source body', () => {
    const bundle = loadBundle('bundle-evm');
    const target = findHistoryCycle(bundle);
    const inflated = target.cycle.realizedPnlUSD + 1_000_000;
    target.cycle.realizedPnlUSD = inflated;

    const result = verifyClaims(bundle);
    expect(result.ok).toBe(false);
    expect(result.mismatches.some((m) => m.includes('does not match its body'))).toBe(true);
  });

  it('still catches it when the tamperer also fixes up the digest', () => {
    const bundle = loadBundle('bundle-evm');
    const source = bundle.sources.find(
      (s) => s.endpoint.includes('positions-history') && s.body !== undefined,
    );
    expect(source).toBeDefined();

    const target = findHistoryCycle(bundle);
    target.cycle.realizedPnlUSD = target.cycle.realizedPnlUSD + 1_000_000;
    // Re-seal the source so the cheap integrity check passes.
    (source as { digest: string }).digest = canonicalDigest(source?.body);

    const result = verifyClaims(bundle);
    expect(result.mismatches.some((m) => m.includes('does not match its body'))).toBe(false);
    expect(result.ok).toBe(false);
    expect(result.mismatches.some((m) => m.startsWith('claim realized-pnl-usd.actual'))).toBe(true);
  });

  it('catches a claim that was flipped to passing', () => {
    const bundle = loadBundle('bundle-evm');
    const failing = bundle.claims.find((c) => !c.passed);
    expect(failing).toBeDefined();
    (failing as { passed: boolean }).passed = true;

    const result = verifyClaims(bundle);
    expect(result.ok).toBe(false);
    expect(result.mismatches.some((m) => m.includes(`claim ${failing?.id}.passed`))).toBe(true);
  });

  it('catches a claim whose measured value was rewritten', () => {
    const bundle = loadBundle('bundle-evm');
    const claim = bundle.claims.find((c) => c.id === 'risk-quality-ratio');
    expect(claim).toBeDefined();
    (claim as { actual?: number }).actual = 0;

    const result = verifyClaims(bundle);
    expect(result.ok).toBe(false);
    expect(result.mismatches.some((m) => m.includes('claim risk-quality-ratio.actual'))).toBe(true);
  });

  it('catches a claim invented out of nothing', () => {
    const bundle = loadBundle('bundle-evm');
    const invented = {
      id: 'never-liquidated',
      statement: 'This wallet has never been liquidated.',
      op: 'eq' as const,
      threshold: 0,
      unit: 'count' as const,
      passed: true,
      actual: 0,
      sources: [0],
    };
    const result = verifyClaims({ ...bundle, claims: [...bundle.claims, invented] });
    expect(result.ok).toBe(false);
    expect(
      result.mismatches.some((m) => m.includes('never-liquidated') && m.includes('cannot be derived')),
    ).toBe(true);
  });

  it('catches a claim that was quietly dropped', () => {
    const bundle = loadBundle('bundle-evm');
    const result = verifyClaims({
      ...bundle,
      claims: bundle.claims.filter((c) => c.id !== 'win-rate'),
    });
    expect(result.ok).toBe(false);
    expect(result.mismatches.some((m) => m.includes('claim win-rate: derivable'))).toBe(true);
  });

  it('catches a body smuggled onto a source that was reported unavailable', () => {
    const bundle = loadBundle('bundle-evm');
    const dead = bundle.sources.find((s) => s.unavailable !== undefined);
    expect(dead).toBeDefined();
    (dead as { body?: unknown }).body = { data: [] };

    const result = verifyClaims(bundle);
    expect(result.ok).toBe(false);
    expect(
      result.mismatches.some((m) => m.includes('marked unavailable but carries a body')),
    ).toBe(true);
  });

  it('recomputes exactly what the bundle already carries', () => {
    const bundle = loadBundle('bundle-solana');
    const result = verifyClaims(bundle);
    expect(canonicalDigest(result.recomputed)).toBe(canonicalDigest(deriveClaims(bundle)));
    expect(canonicalDigest(result.recomputed)).toBe(canonicalDigest(bundle.claims));
  });
});

interface MutableCycle {
  cycle: { realizedPnlUSD: number };
}

function findHistoryCycle(bundle: EvidenceBundle): MutableCycle {
  for (const source of bundle.sources) {
    if (!source.endpoint.includes('positions-history')) continue;
    const body = source.body as { data?: MutableCycle[] } | undefined;
    const entry = body?.data?.[0];
    if (entry !== undefined) return entry;
  }
  throw new Error('fixture carries no position history');
}
