import { describe, expect, it } from 'vitest';

import { commitmentFor, toClaimSet } from '../src/claimset.js';
import { CLAIMS_SCHEMA } from '../src/sdk.js';
import { BUNDLE_NAMES, loadBundle } from './helpers.js';

describe('toClaimSet', () => {
  it.each(BUNDLE_NAMES)('drops the address from %s entirely', (name) => {
    const bundle = loadBundle(name);
    const encoded = JSON.stringify(toClaimSet(bundle));
    expect(encoded.toLowerCase()).not.toContain(bundle.subject.address.toLowerCase());
    expect(encoded).not.toContain(bundle.subject.address);
  });

  it.each(BUNDLE_NAMES)('drops every measured value from %s', (name) => {
    const claimSet = toClaimSet(loadBundle(name));
    for (const claim of claimSet.claims) {
      expect(Object.hasOwn(claim, 'actual')).toBe(false);
    }
  });

  it.each(BUNDLE_NAMES)('carries no raw upstream body from %s', (name) => {
    const bundle = loadBundle(name);
    const claimSet = toClaimSet(bundle);
    expect(Object.hasOwn(claimSet, 'sources')).toBe(false);

    // Nothing that only appears inside a raw Mobula response may survive.
    const encoded = JSON.stringify(claimSet);
    expect(encoded).not.toContain('securityScoreDetails');
    expect(encoded).not.toContain('transactionHash');
    expect(encoded).not.toContain('mevFeesUSD');
    // Two orders of magnitude smaller than the bundle it came from.
    expect(encoded.length * 100).toBeLessThan(JSON.stringify(bundle).length);
  });

  it('keeps everything a counterparty needs to act', () => {
    const bundle = loadBundle('bundle-evm');
    const claimSet = toClaimSet(bundle);
    expect(claimSet.schema).toBe(CLAIMS_SCHEMA);
    expect(claimSet.referenceId).toBe(bundle.referenceId);
    expect(claimSet.chains).toEqual([...bundle.subject.chains]);
    expect(claimSet.window).toEqual(bundle.window);
    expect(claimSet.derivationId).toBe(bundle.derivationId);
    expect(claimSet.claims.map((c) => c.id)).toEqual(bundle.claims.map((c) => c.id));
    for (const claim of claimSet.claims) {
      expect(claim.statement.length).toBeGreaterThan(0);
      expect(typeof claim.passed).toBe('boolean');
      expect(claim.sources.length).toBeGreaterThan(0);
    }
  });

  it('keeps the source indices so a tier-1 reader can see how many backed a claim', () => {
    const bundle = loadBundle('bundle-evm');
    const claimSet = toClaimSet(bundle);
    for (const [i, claim] of claimSet.claims.entries()) {
      expect(claim.sources).toEqual([...(bundle.claims[i]?.sources ?? [])]);
    }
  });
});

describe('commitmentFor', () => {
  it('is stable for the same bundle', () => {
    const a = commitmentFor(loadBundle('bundle-evm'));
    const b = commitmentFor(loadBundle('bundle-evm'));
    expect(a).toBe(b);
    expect(a).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it('differs between two different references', () => {
    expect(commitmentFor(loadBundle('bundle-evm'))).not.toBe(
      commitmentFor(loadBundle('bundle-solana')),
    );
  });

  it('moves when a single claim outcome moves', () => {
    const bundle = loadBundle('bundle-evm');
    const before = commitmentFor(bundle);
    const flipped = {
      ...bundle,
      claims: bundle.claims.map((c, i) => (i === 0 ? { ...c, passed: !c.passed } : c)),
    };
    expect(commitmentFor(flipped)).not.toBe(before);
  });
});
