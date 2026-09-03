import { describe, expect, it } from 'vitest';

import {
  CLAIM_SPECS,
  DERIVATION,
  DERIVATION_ID,
  DERIVATION_PARAMS,
  deriveClaims,
  deriveMetrics,
} from '../src/derive.js';
import { canonicalDigest, canonicalize } from '../src/sdk.js';
import type { EvidenceBundle } from '../src/sdk.js';
import { BUNDLE_NAMES, clone, loadBundle } from './helpers.js';

describe('deriveClaims', () => {
  it.each(BUNDLE_NAMES)('derives every claim from the recorded %s', (name) => {
    const claims = deriveClaims(loadBundle(name));
    expect(claims.map((c) => c.id)).toEqual(CLAIM_SPECS.map((s) => s.id));
    for (const claim of claims) expect(typeof claim.actual).toBe('number');
  });

  it.each(BUNDLE_NAMES)('is byte-identical across runs on %s', (name) => {
    const a = canonicalDigest(deriveClaims(loadBundle(name)));
    const b = canonicalDigest(deriveClaims(loadBundle(name)));
    expect(a).toBe(b);
  });

  it('does not depend on the key order of the bundle it is given', () => {
    const bundle = loadBundle('bundle-evm');
    const reordered = reverseKeys(bundle) as EvidenceBundle;
    expect(canonicalDigest(deriveClaims(reordered))).toBe(canonicalDigest(deriveClaims(bundle)));
  });

  it('does not read the clock — the window end is the only notion of now', () => {
    const bundle = loadBundle('bundle-evm');
    const first = deriveClaims(bundle);
    const later = deriveClaims({ ...bundle, derivedAt: '2099-01-01T00:00:00.000Z' });
    expect(canonicalDigest(later)).toBe(canonicalDigest(first));
  });

  it.each(BUNDLE_NAMES)('never cites an unavailable source on %s', (name) => {
    const bundle = loadBundle(name);
    const bodyless = new Set(
      bundle.sources.filter((s) => s.unavailable !== undefined).map((s) => s.index),
    );
    expect(bodyless.size).toBeGreaterThan(0);
    for (const claim of deriveClaims(bundle)) {
      for (const index of claim.sources) expect(bodyless.has(index)).toBe(false);
    }
  });

  it('omits claims whose sources are absent rather than defaulting them', () => {
    const bundle = loadBundle('bundle-evm');
    const stripped: EvidenceBundle = {
      ...bundle,
      sources: bundle.sources.filter((s) => !s.endpoint.includes('positions-history')),
    };
    const ids = deriveClaims(stripped).map((c) => c.id);
    expect(ids).not.toContain('realized-pnl-usd');
    expect(ids).not.toContain('win-rate');
    // Wallet age comes from `/2/wallet/funding` and survives untouched.
    expect(ids).toContain('wallet-age-days');
  });

  it('narrowing the window can only remove cycles', () => {
    const bundle = loadBundle('bundle-evm');
    const wide = deriveMetrics(bundle).closedCycles.length;
    const narrow = deriveMetrics({
      ...bundle,
      window: { from: '2026-01-01T00:00:00.000Z', to: bundle.window.to },
    }).closedCycles.length;
    expect(narrow).toBeLessThanOrEqual(wide);
  });

  it('sums realized PnL over exactly the cycles it counted', () => {
    const bundle = loadBundle('bundle-evm');
    const metrics = deriveMetrics(bundle);
    const expected = metrics.closedCycles.reduce((sum, c) => sum + c.realizedPnlUsd, 0);
    // The reported figure is rounded to cents; the raw sum is not.
    expect(metrics.realizedPnlUsd).toBeCloseTo(expected, 2);
    const claim = deriveClaims(bundle).find((c) => c.id === 'realized-pnl-usd');
    expect(claim?.actual).toBe(metrics.realizedPnlUsd);
  });

  it('win rate is the share of counted cycles that made money', () => {
    const metrics = deriveMetrics(loadBundle('bundle-solana'));
    const wins = metrics.closedCycles.filter((c) => c.realizedPnlUsd > 0).length;
    expect(metrics.winRate).toBeCloseTo(wins / metrics.closedCycles.length, 6);
  });

  it('max drawdown is the deepest fall of the cumulative curve', () => {
    const metrics = deriveMetrics(loadBundle('bundle-evm'));
    let cumulative = 0;
    let peak = 0;
    let worst = 0;
    for (const cycle of metrics.closedCycles) {
      cumulative += cycle.realizedPnlUsd;
      peak = Math.max(peak, cumulative);
      worst = Math.max(worst, peak - cumulative);
    }
    expect(metrics.maxDrawdownUsd).toBeCloseTo(worst, 2);
  });

  it('risk quality counts assets Mobula scored below the floor', () => {
    const metrics = deriveMetrics(loadBundle('bundle-evm'));
    expect(metrics.security.scored).toBeGreaterThan(0);
    const risky = metrics.security.readings.filter(
      (r) => r.killed || r.score < DERIVATION_PARAMS.securityScoreFloor,
    ).length;
    expect(metrics.security.risky).toBe(risky);
    expect(metrics.security.riskyShare).toBeCloseTo(risky / metrics.security.scored, 6);
  });

  it('counts assets it could not score separately instead of assuming them safe', () => {
    const metrics = deriveMetrics(loadBundle('bundle-evm'));
    expect(metrics.security.scored + metrics.security.unscored).toBe(metrics.security.tradedAssets);
    expect(metrics.security.unscored).toBeGreaterThanOrEqual(0);
  });

  it('reports the MEV slice of trading costs from the sampled swaps', () => {
    const metrics = deriveMetrics(loadBundle('bundle-solana'));
    expect(metrics.mev.sampledTrades).toBeGreaterThan(0);
    expect(metrics.mev.mevFeesUsd).toBeLessThanOrEqual(metrics.mev.totalFeesUsd);
    // Both totals are reported rounded to cents, so the quotient of the reported
    // pair only agrees with the reported share to a few decimals.
    expect(metrics.mev.share).toBeCloseTo(metrics.mev.mevFeesUsd / metrics.mev.totalFeesUsd, 3);
  });
});

describe('claim statements', () => {
  it.each(BUNDLE_NAMES)('never leak the measured value on %s', (name) => {
    for (const claim of deriveClaims(loadBundle(name))) {
      if (claim.actual === undefined) continue;
      // A small whole number is not a leak — every threshold sentence contains
      // digits. What must never appear is a distinctive measurement.
      if (Number.isInteger(claim.actual) && Math.abs(claim.actual) < 10) continue;
      if (claim.actual === claim.threshold) continue;
      expect(claim.statement).not.toContain(String(claim.actual));
    }
  });

  it('read as plain English: no addresses, hashes or field names', () => {
    for (const spec of CLAIM_SPECS) {
      expect(spec.statement).not.toMatch(/0x[0-9a-f]{6}/i);
      expect(spec.statement).not.toMatch(/[a-z]+[A-Z][a-zA-Z]*USD/);
      expect(spec.statement).not.toMatch(/\/2\//);
      expect(spec.statement.length).toBeGreaterThan(40);
      expect(spec.statement.trimEnd()).toMatch(/[.!]$/);
    }
  });
});

describe('DERIVATION_ID', () => {
  it('is a digest of the rules and their parameters', () => {
    expect(DERIVATION_ID).toBe(canonicalDigest(DERIVATION));
    expect(DERIVATION_ID).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it('changes when a threshold changes', () => {
    const shifted = {
      ...DERIVATION,
      params: { ...DERIVATION.params, minWinRate: 0.9 },
    };
    expect(canonicalDigest(shifted)).not.toBe(DERIVATION_ID);
  });

  it('cannot drift from what the derivation actually emits', () => {
    const emitted = deriveClaims(loadBundle('bundle-evm'));
    const described = new Map(DERIVATION.claims.map((c) => [c.id, c]));
    expect(emitted.length).toBe(DERIVATION.claims.length);
    for (const claim of emitted) {
      const spec = described.get(claim.id);
      expect(spec, `claim ${claim.id} is emitted but not described`).toBeDefined();
      expect(canonicalize(claim.op)).toBe(canonicalize(spec?.op));
      expect(canonicalize(claim.threshold)).toBe(canonicalize(spec?.threshold));
      expect(canonicalize(claim.unit)).toBe(canonicalize(spec?.unit));
      expect(claim.statement).toBe(spec?.statement);
    }
  });
});

/** Rebuilds every object with its keys reversed, to prove ordering is irrelevant. */
function reverseKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reverseKeys);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).reverse()) {
      out[key] = reverseKeys((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return clone(value);
}
