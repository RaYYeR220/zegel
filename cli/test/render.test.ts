import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { CLAIM_SPECS } from '@zegel/evidence';
import { ENVELOPE_SCHEMA, type Claim, type EvidenceBundle, type SealedEnvelope } from '@zegel/sdk/types';

import { analyseExposure } from '../src/core/exposure.js';
import { assessReference } from '../src/core/status.js';
import type { ProbeResult } from '../src/core/probes.js';
import { paintStatus, renderCapabilities, statusWord } from '../src/render/capability.js';
import { claimTally, renderClaimSummary, renderClaims, renderMissingClaims } from '../src/render/claims.js';
import { renderAssessment, renderEnvelope } from '../src/render/envelope.js';
import { stripAnsi } from '../src/render/layout.js';
import { renderScan } from '../src/render/scan.js';
import { plainTheme } from '../src/render/theme.js';

const theme = plainTheme(90);

const bundle = JSON.parse(
  readFileSync(
    fileURLToPath(new URL('../../packages/evidence/test/fixtures/bundle-evm.json', import.meta.url)),
    'utf8',
  ),
) as EvidenceBundle;

const text = (rows: readonly string[]): string => stripAnsi(rows.join('\n'));

/** Prose is wrapped to the terminal width, so assertions on a sentence read it flat. */
const flat = (rows: readonly string[]): string => text(rows).replace(/\s+/g, ' ');

describe('claim rendering', () => {
  const claims = bundle.claims;

  it('marks every claim as met or not met, in words as well as glyphs', () => {
    const rendered = text(renderClaims(theme, claims, { showActual: true }));
    expect(rendered).toContain('not met');
    expect(rendered).toContain('— met');
  });

  it('prints the measured value with its unit when the caller holds it', () => {
    const rendered = text(renderClaims(theme, claims, { showActual: true }));
    expect(rendered).toContain('measured -$12,526.91');
    expect(rendered).toContain('(usd)');
  });

  it('withholds the measured value at tier 1 rather than printing a placeholder', () => {
    const tierOne: Claim[] = claims.map(({ actual: _actual, ...rest }) => rest);
    const rendered = text(renderClaims(theme, tierOne));
    expect(rendered).toContain('measured value withheld at this tier');
    expect(rendered).not.toContain('-$12,526.91');
  });

  it('always states the assertion, whichever tier is being read', () => {
    const rendered = text(renderClaims(theme, claims));
    expect(rendered).toContain('asserts at least');
    expect(rendered).toContain('asserts at most');
  });

  it('names the upstream endpoint and digest behind a claim under --explain', () => {
    const one = claims.filter((c) => c.id === 'wallet-age-days');
    const rendered = text(renderClaims(theme, one, { explain: true, sources: bundle.sources }));
    expect(rendered).toContain('GET /2/wallet/funding');
    expect(rendered).toContain('digest 0x');
    expect(rendered).toContain('wallet=0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045');
  });

  it('says a source is absent instead of pretending it explained one', () => {
    const orphan: Claim[] = [{ ...claims[0]!, sources: [999] }];
    const rendered = text(renderClaims(theme, orphan, { explain: true, sources: bundle.sources }));
    expect(rendered).toContain('source[999] (not in this payload)');
  });

  it('tallies met against not met', () => {
    expect(claimTally(claims)).toEqual({ passed: 6, failed: 4, total: 10 });
    expect(text(renderClaimSummary(theme, claims))).toContain('6 met / 4 not met of 10');
  });

  it('says so when every claim was met', () => {
    const allPassed = claims.map((c) => ({ ...c, passed: true }));
    expect(text(renderClaimSummary(theme, allPassed))).toContain('all 10 claims met');
  });

  it('separates claims that could not be computed from claims that failed', () => {
    const partial = claims.filter((c) => c.id !== 'mev-fee-share');
    const rendered = text(
      renderMissingClaims(theme, partial, CLAIM_SPECS.map((spec) => spec.id)),
    );
    expect(rendered).toContain('mev-fee-share');
    expect(rendered).toContain('absent, not failed');
  });

  it('renders nothing when every claim was computed', () => {
    expect(renderMissingClaims(theme, claims, CLAIM_SPECS.map((s) => s.id))).toEqual([]);
  });
});

describe('the exposure dossier', () => {
  const report = analyseExposure(bundle);
  const lines = renderScan(theme, report, { ensName: 'vitalik.eth', elapsedSeconds: 31.4 });
  const rendered = text(lines);
  const prose = flat(lines);

  it('leads with the subject and the window', () => {
    expect(rendered).toContain('EXPOSURE DOSSIER');
    expect(rendered).toContain('vitalik.eth');
    expect(rendered).toContain('0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045');
  });

  it('states what the dossier cost to produce, which is the argument', () => {
    expect(rendered).toContain('31.4 s');
    expect(rendered).toContain('no key, no signup');
  });

  it('gives every money figure a currency marker', () => {
    expect(rendered).toContain('-$12,526.91');
    expect(rendered).toMatch(/realized profit\/loss\s+-\$/);
  });

  it('names the first funder and says why that link matters', () => {
    expect(rendered).toContain('Vitalik Buterin');
    expect(prose).toContain('hardest thing about a wallet to disown');
  });

  it('states the timezone assumption next to the timezone conclusion', () => {
    expect(rendered).toContain('implied timezone');
    expect(prose).toContain('the quietest eight hours of the day are a night');
  });

  it('shows the raw histogram so the inference can be rejected', () => {
    expect(rendered).toContain('15:00');
    expect(rendered).toContain('activity concentration');
  });

  it('reports Mobula scores verbatim and says it is doing so', () => {
    expect(prose).toContain('second-guessing the vendor would make the number unverifiable');
    expect(prose).toContain('14-point safety check');
  });

  it('lists the upstreams it could not collect', () => {
    expect(rendered).toContain('WHAT COULD NOT BE COLLECTED');
    expect(rendered).toContain('GET /2/wallet/analysis');
    expect(prose).toContain('recorded as unavailable rather than filled in');
  });

  it('closes with the product argument rather than the data', () => {
    expect(prose).toContain('None of this needed your consent, your signature or your key');
    expect(prose).toContain('zegel issue turns this dossier into a sealed set of derived claims');
  });

  it('names the source endpoint per section under --explain, and not otherwise', () => {
    const explained = text(renderScan(theme, report, { explain: true }));
    expect(explained).toContain('GET /2/wallet/funding source[');
    expect(rendered).not.toContain('GET /2/wallet/funding source[');
  });

  it('emits no escape sequences under a plain theme', () => {
    const raw = renderScan(theme, report).join('\n');
    expect(raw.includes(String.fromCharCode(27))).toBe(false);
  });
});

describe('capability table', () => {
  const results: ProbeResult[] = [
    {
      id: 'mobula-demo',
      name: 'Mobula demo host (no key, no signup)',
      status: 'ok',
      endpoint: 'https://demo-api.mobula.io/api/2/market/lighthouse',
      detail: 'HTTP 200',
      cost: '',
      latencyMs: 337,
    },
    {
      id: 'bee-node',
      name: 'Local Bee node (grant / revoke)',
      status: 'unavailable',
      endpoint: 'http://127.0.0.1:1633',
      detail: 'fetch failed',
      cost: 'grant and revoke are impossible',
      latencyMs: 12,
    },
    {
      id: 'mobula-prod',
      name: 'Mobula production host (MOBULA_API_KEY)',
      status: 'not-configured',
      endpoint: 'https://api.mobula.io/api/2/market/lighthouse',
      detail: 'MOBULA_API_KEY is not set',
      cost: 'higher rate limits are unavailable',
      latencyMs: null,
    },
  ];

  it('distinguishes broken from simply unconfigured', () => {
    expect(statusWord('unavailable')).toBe('unavailable');
    expect(statusWord('not-configured')).toBe('not set up');
    expect(stripAnsi(paintStatus(theme, 'ok'))).toContain('works');
  });

  it('prints what each degraded capability costs you', () => {
    const rendered = text(renderCapabilities(theme, results));
    expect(rendered).toContain('WHAT THAT COSTS YOU');
    expect(rendered).toContain('grant and revoke are impossible');
  });

  it('prints the exact URL of every probe, so a reader can repeat it', () => {
    const rendered = text(renderCapabilities(theme, results));
    for (const result of results) expect(rendered).toContain(result.endpoint);
  });

  it('renders a missing latency as a dash, never as zero', () => {
    const rendered = text(renderCapabilities(theme, results));
    expect(rendered).toContain('—');
    expect(rendered).not.toContain('0 ms');
  });
});

describe('envelope and verdict rendering', () => {
  const envelope: SealedEnvelope = {
    schema: ENVELOPE_SCHEMA,
    referenceId: `0x${'a'.repeat(64)}`,
    commitment: `0x${'b'.repeat(64)}`,
    issuedAt: '2026-09-04T22:55:00.000Z',
    expiresAt: '2026-10-04T22:55:00.000Z',
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
  };

  it('prints the commitment in full, because it is what a reader recomputes', () => {
    expect(text(renderEnvelope(theme, envelope))).toContain(envelope.commitment);
  });

  it('says an envelope is not anchored rather than leaving the field blank', () => {
    expect(text(renderEnvelope(theme, envelope))).toContain('not anchored');
  });

  it('flags an envelope with no publishable tier', () => {
    const rendered = text(renderEnvelope(theme, { ...envelope, tiers: [] }));
    expect(rendered).toContain('none published');
  });

  it('leads the verdict with the status word', () => {
    const assessment = assessReference({
      envelope,
      now: new Date('2026-09-05T00:00:00.000Z'),
      commitment: { checked: true, matches: false, recomputed: '0xdead' },
    });
    const rendered = text(renderAssessment(theme, assessment));
    expect(rendered).toContain('TAMPERED');
    expect(rendered).toContain('CHECKS RUN');
  });

  it('lists skipped checks as skipped, not as passes', () => {
    const assessment = assessReference({ envelope, now: new Date('2026-09-05T00:00:00.000Z') });
    const rendered = text(renderAssessment(theme, assessment));
    expect(rendered).toContain('- on-chain anchor');
    expect(rendered).toContain('- sealed tier');
  });
});
