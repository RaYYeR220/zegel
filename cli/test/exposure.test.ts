import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import type { EvidenceBundle } from '@zegel/sdk/types';

import { analyseExposure, inferClock } from '../src/core/exposure.js';

/**
 * The fixture is a real recorded collection from the Mobula demo host, not
 * invented JSON — so these assertions also catch a change in the upstream shape
 * rather than only in our arithmetic.
 */
const bundle = JSON.parse(
  readFileSync(
    fileURLToPath(new URL('../../packages/evidence/test/fixtures/bundle-evm.json', import.meta.url)),
    'utf8',
  ),
) as EvidenceBundle;

const report = analyseExposure(bundle);

describe('the dossier, against recorded live data', () => {
  it('carries the subject and window from the bundle', () => {
    expect(report.address).toBe('0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045');
    expect(report.chains).toEqual(['evm:1', 'evm:8453']);
  });

  it('reproduces the derivation, so the dossier and the claims cannot disagree', () => {
    expect(report.metrics.realizedPnlUsd).toBe(-12_526.91);
    expect(report.metrics.closedCycles).toHaveLength(20);
    expect(report.metrics.winRate).toBe(0.2);
  });

  it('names the first funder, with the entity the vendor attached to it', () => {
    expect(report.funding?.entityName).toBe('Vitalik Buterin');
    expect(report.funding?.entityType).toBe('individual');
    expect(report.funding?.dateIso).toBe('2015-09-28T08:24:43.000Z');
    expect(report.funding?.ageDays).toBeGreaterThan(3900);
  });

  it('labels the venues it recognises and refuses to guess at the rest', () => {
    const known = report.venues.find((v) => v.address === '0x7a250d5630b4cf539739df2c5dacb4c659f2488d');
    expect(known?.label).toBe('Uniswap V2 Router 02');
    for (const venue of report.venues) {
      expect(typeof venue.label === 'string' || venue.label === null).toBe(true);
    }
  });

  it('shares across venues sum to one', () => {
    const total = report.venues.reduce((sum, v) => sum + v.share, 0);
    expect(total).toBeCloseTo(1, 6);
  });

  it('ranks the worst positions by realized loss, worst first', () => {
    expect(report.worstAssets[0]?.symbol).toBe('YUNA');
    for (let i = 1; i < report.worstAssets.length; i++) {
      expect(report.worstAssets[i]!.realizedPnlUsd).toBeGreaterThanOrEqual(
        report.worstAssets[i - 1]!.realizedPnlUsd,
      );
    }
  });

  it('separates gains from losses rather than mixing them into one list', () => {
    expect(report.bestAssets.every((a) => a.realizedPnlUsd > 0)).toBe(true);
    expect(report.worstAssets.every((a) => a.realizedPnlUsd < 0)).toBe(true);
  });

  it('sorts security readings worst-score first, so the risk is the first thing read', () => {
    for (let i = 1; i < report.riskiest.length; i++) {
      expect(report.riskiest[i]!.score).toBeGreaterThanOrEqual(report.riskiest[i - 1]!.score);
    }
  });

  it('reports what could not be collected instead of dropping it', () => {
    const endpoints = report.unavailable.map((u) => u.endpoint);
    expect(endpoints).toContain('GET /2/wallet/analysis');
    expect(endpoints).toContain('GET /1/wallet/history');
    expect(report.unavailable.every((u) => u.reason.length > 0)).toBe(true);
  });

  it('attributes each section to the source indices behind it', () => {
    expect(report.provenance['assets']?.length).toBeGreaterThan(0);
    expect(report.provenance['funding']?.length).toBe(1);
    expect(report.provenance['risk']?.length).toBeGreaterThan(0);
  });

  it('never lists the subject itself among the linked addresses', () => {
    const subject = report.address.toLowerCase();
    expect(report.linkedAddresses).not.toContain(subject);
  });

  it('orders holdings by value and reports the total it can see', () => {
    for (let i = 1; i < report.holdings.length; i++) {
      expect(report.holdings[i]!.valueUsd).toBeLessThanOrEqual(report.holdings[i - 1]!.valueUsd);
    }
    expect(report.holdingsValueUsd).toBeGreaterThan(0);
  });
});

describe('the clock fingerprint', () => {
  const hoursToTimestamps = (hours: readonly number[]): number[] =>
    hours.map((hour, i) => Date.UTC(2026, 0, 1 + Math.floor(i / 24), hour, 0, 0));

  it('is null when there is nothing to read', () => {
    expect(inferClock([])).toBeNull();
  });

  it('finds the quiet stretch and derives an offset from it', () => {
    // Busy 14:00-17:00 UTC, silent 18:00-05:00: a local night starting at 18:00 UTC.
    const hours = [14, 14, 14, 15, 15, 15, 15, 16, 16, 17, 13, 12, 11, 10, 9, 8, 7, 6];
    const clock = inferClock(hoursToTimestamps(hours));
    expect(clock?.quietStartUtc).toBe(18);
    expect(clock?.impliedOffsetHours).toBe(6);
  });

  it('expresses a western offset as a negative number, not as UTC+19', () => {
    const hours = [1, 2, 2, 3, 3, 3, 4, 4, 5, 0, 23, 22];
    const clock = inferClock(hoursToTimestamps(hours));
    expect(clock?.impliedOffsetHours).toBeLessThanOrEqual(0);
    expect(clock?.impliedOffsetHours).toBeGreaterThanOrEqual(-11);
  });

  it('calls a flat, round-the-clock pattern weak rather than attaching a location to it', () => {
    const hours = Array.from({ length: 48 }, (_, i) => i % 24);
    const clock = inferClock(hoursToTimestamps(hours));
    expect(clock?.confidence).toBe('weak');
  });

  it('calls a tight, well-sampled pattern strong', () => {
    const hours = Array.from({ length: 60 }, (_, i) => 14 + (i % 3));
    const clock = inferClock(hoursToTimestamps(hours));
    expect(clock?.confidence).toBe('strong');
    expect(clock?.concentration).toBeGreaterThan(0.9);
  });

  it('counts every sample into the histogram exactly once', () => {
    const hours = [1, 1, 2, 3, 3, 3];
    const clock = inferClock(hoursToTimestamps(hours));
    expect(clock?.histogram.reduce((a, b) => a + b, 0)).toBe(hours.length);
    expect(clock?.samples).toBe(hours.length);
  });

  it('drops unusable timestamps rather than bucketing them at hour zero', () => {
    const clock = inferClock([Number.NaN, 0, -1, Date.UTC(2026, 0, 1, 9, 0, 0)]);
    expect(clock?.samples).toBe(1);
  });

  it('reads a real recorded trade history as a concentrated afternoon pattern', () => {
    expect(report.clock?.busiestHours[0]).toBe(15);
    expect(report.clock?.confidence).not.toBe('weak');
  });
});
