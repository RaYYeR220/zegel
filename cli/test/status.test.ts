import { describe, expect, it } from 'vitest';

import { ENVELOPE_SCHEMA, type SealedEnvelope } from '@zegel/sdk/types';

import { assessReference, EXIT_CODES, type AssessInput } from '../src/core/status.js';

const NOW = new Date('2026-09-04T12:00:00.000Z');

function envelope(overrides: Partial<SealedEnvelope> = {}): SealedEnvelope {
  return {
    schema: ENVELOPE_SCHEMA,
    referenceId: '0x'.padEnd(66, 'a'),
    commitment: '0x'.padEnd(66, 'b'),
    issuedAt: '2026-09-01T00:00:00.000Z',
    expiresAt: '2026-10-01T00:00:00.000Z',
    tiers: [
      {
        tier: 1,
        swarmRef: 'ab'.repeat(32),
        actHistoryAddress: 'cd'.repeat(32),
        actPublisher: `02${'ef'.repeat(32)}`,
      },
    ],
    anchors: {},
    revocationHint: { contract: '', chainId: 8453 },
    ...overrides,
  };
}

function assess(overrides: Partial<AssessInput> = {}) {
  return assessReference({ envelope: envelope(), now: NOW, ...overrides });
}

const matching = { checked: true, matches: true, recomputed: '0x'.padEnd(66, 'b') } as const;
const mismatching = { checked: true, matches: false, recomputed: '0xdeadbeef' } as const;

describe('the five verdicts a counterparty acts on', () => {
  it('is valid when the commitment matches and nothing has expired', () => {
    const result = assess({ commitment: matching });
    expect(result.status).toBe('valid');
    expect(result.exitCode).toBe(0);
  });

  it('is expired when the envelope aged out, and says nobody withdrew it', () => {
    const result = assess({
      envelope: envelope({ expiresAt: '2026-09-03T00:00:00.000Z' }),
      commitment: matching,
    });
    expect(result.status).toBe('expired');
    expect(result.exitCode).toBe(EXIT_CODES.expired);
    expect(result.reasons.join(' ')).toContain('aged out');
  });

  it('is revoked when the anchor says so', () => {
    const result = assess({ commitment: matching, anchor: 'revoked' });
    expect(result.status).toBe('revoked');
    expect(result.exitCode).toBe(EXIT_CODES.revoked);
  });

  it('is tampered when the recomputed commitment differs', () => {
    const result = assess({ commitment: mismatching });
    expect(result.status).toBe('tampered');
    expect(result.exitCode).toBe(EXIT_CODES.tampered);
    expect(result.reasons.join(' ')).toContain('Do not rely on it');
  });

  it('is tampered when the anchor reports a different commitment', () => {
    const result = assess({ commitment: matching, anchor: 'commitment-mismatch' });
    expect(result.status).toBe('tampered');
  });

  it('is not-granted when Swarm answered 404', () => {
    const result = assess({ commitment: matching, tierRead: 'not-granted' });
    expect(result.status).toBe('not-granted');
    expect(result.exitCode).toBe(EXIT_CODES['not-granted']);
  });

  it('says a 404 is indistinguishable from never having existed', () => {
    const result = assess({ tierRead: 'not-granted' });
    expect(result.reasons.join(' ')).toContain('never existed');
  });
});

describe('precedence between simultaneous failures', () => {
  it('reports tampering ahead of revocation, because it is the louder fact', () => {
    expect(assess({ commitment: mismatching, anchor: 'revoked' }).status).toBe('tampered');
  });

  it('reports revocation ahead of expiry, because someone acted', () => {
    const result = assess({
      envelope: envelope({ expiresAt: '2026-09-03T00:00:00.000Z' }),
      commitment: matching,
      anchor: 'revoked',
    });
    expect(result.status).toBe('revoked');
  });

  it('reports expiry ahead of a missing grant', () => {
    const result = assess({
      envelope: envelope({ expiresAt: '2026-09-03T00:00:00.000Z' }),
      commitment: matching,
      tierRead: 'not-granted',
    });
    expect(result.status).toBe('expired');
  });

  it('reports malformed ahead of everything', () => {
    const result = assessReference({ envelope: null, now: NOW, malformed: 'not valid JSON' });
    expect(result.status).toBe('malformed');
    expect(result.exitCode).toBe(EXIT_CODES.malformed);
  });
});

describe('refusing to round anything up', () => {
  it('will not call an envelope valid when nothing could be checked', () => {
    const result = assess({});
    expect(result.status).toBe('unverifiable');
    expect(result.exitCode).toBe(EXIT_CODES.unverifiable);
    expect(result.reasons.join(' ')).toContain('not evidence of anything');
  });

  it('records that no anchor was consulted, so revocation stays unruled-out', () => {
    const result = assess({ commitment: matching });
    expect(result.anchorChecked).toBe(false);
    expect(result.reasons.join(' ')).toContain('revocation could not be ruled out');
  });

  it('reports a never-anchored reference as checked but unobservable', () => {
    const result = assess({ commitment: matching, anchor: 'never-anchored' });
    expect(result.status).toBe('valid');
    expect(result.anchorChecked).toBe(true);
    expect(result.reasons.join(' ')).toContain('no record of this reference id');
  });

  it('accepts an opened tier as proof enough on its own', () => {
    expect(assess({ tierRead: 'granted' }).status).toBe('valid');
  });

  it('flags an envelope that publishes no tier, while still trusting the commitment', () => {
    const result = assess({ envelope: envelope({ tiers: [] }), commitment: matching });
    expect(result.status).toBe('valid');
    expect(result.reasons.join(' ')).toContain('no sealed tier');
  });

  it('marks an unreadable expiry as skipped rather than passed', () => {
    const result = assess({ envelope: envelope({ expiresAt: 'whenever' }), commitment: matching });
    const expiry = result.checks.find((c) => c.name === 'expiry');
    expect(expiry?.outcome).toBe('skipped');
  });
});

describe('the check list', () => {
  it('reports every check with an outcome, including the ones not run', () => {
    const result = assess({ commitment: matching });
    expect(result.checks.map((c) => c.name)).toEqual([
      'envelope schema',
      'expiry',
      'commitment',
      'on-chain anchor',
      'sealed tier',
    ]);
    expect(result.checks.filter((c) => c.outcome === 'skipped')).toHaveLength(2);
  });

  it('prints the hashes it compared, so a reader can repeat the comparison', () => {
    const commitment = result();
    expect(commitment).toContain('0xdeadbeef');
    function result(): string {
      return assess({ commitment: mismatching }).checks.find((c) => c.name === 'commitment')?.detail ?? '';
    }
  });

  it('gives every status a distinct exit code', () => {
    const codes = Object.values(EXIT_CODES);
    expect(new Set(codes).size).toBe(codes.length);
  });
});
