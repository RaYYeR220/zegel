import { describe, expect, it } from 'vitest';

import {
  count,
  days,
  hourWindow,
  inUnit,
  isoDay,
  isoMinute,
  opWords,
  percent,
  plural,
  score,
  shortAddress,
  thresholdIn,
  usd,
  usdSigned,
  utcOffset,
  wrap,
} from '../src/render/format.js';

describe('money', () => {
  it('renders dollars with a currency marker and two decimals', () => {
    expect(usd(1234.5)).toBe('$1,234.50');
  });

  it('keeps the sign in front of the currency marker for losses', () => {
    expect(usd(-12_526.91)).toBe('-$12,526.91');
  });

  it('keeps sub-cent amounts non-zero rather than rounding them away', () => {
    expect(usd(0.0004)).toBe('$0.00040');
  });

  it('drops decimals above a million, where they are noise', () => {
    expect(usd(2_500_000)).toBe('$2,500,000');
  });

  it('marks a gain explicitly, because direction is the whole point', () => {
    expect(usdSigned(5.08)).toBe('+$5.08');
    expect(usdSigned(-8158.75)).toBe('-$8,158.75');
  });

  it('says so rather than printing NaN', () => {
    expect(usd(Number.NaN)).toBe('unavailable');
    expect(percent(Number.POSITIVE_INFINITY)).toBe('unavailable');
  });
});

describe('units', () => {
  it('renders a ratio as a percentage', () => {
    expect(percent(0.2)).toBe('20.0%');
    expect(percent(0.008687, 2)).toBe('0.87%');
  });

  it('pluralises days and adds a years hint for long spans', () => {
    expect(days(1)).toBe('1.0 day');
    expect(days(524.75)).toBe('524.8 days');
    expect(days(3993.54)).toBe('3993.5 days (10.9 years)');
  });

  it('renders a security score out of 100', () => {
    expect(score(27)).toBe('27/100');
  });

  it('routes a claim value through its declared unit', () => {
    expect(inUnit(20, 'count')).toBe('20');
    expect(inUnit(0.75, 'ratio')).toBe('75.0%');
    expect(inUnit(-12_526.91, 'usd')).toBe('-$12,526.91');
    expect(inUnit(180, 'days')).toBe('180.0 days');
    expect(inUnit(60, 'score')).toBe('60/100');
  });

  it('renders a banded threshold as a range in the same unit', () => {
    expect(thresholdIn([0.2, 0.8], 'ratio')).toBe('20.0%..80.0%');
  });

  it('turns an operator into words a non-technical reader can follow', () => {
    expect(opWords('gte')).toBe('at least');
    expect(opWords('lte')).toBe('at most');
  });

  it('formats counts with thousands separators', () => {
    expect(count(1250)).toBe('1,250');
  });

  it('pluralises on demand', () => {
    expect(plural(1, 'cycle')).toBe('cycle');
    expect(plural(2, 'cycle')).toBe('cycles');
  });
});

describe('identifiers and time', () => {
  it('truncates an address in the middle, keeping both ends', () => {
    expect(shortAddress('0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045')).toBe('0xd8dA…6045');
  });

  it('leaves a short value alone', () => {
    expect(shortAddress('0xabcd')).toBe('0xabcd');
  });

  it('renders dates in UTC ISO, never in the local locale', () => {
    expect(isoDay('2026-09-04T22:55:45.302Z')).toBe('2026-09-04');
    expect(isoMinute('2026-09-04T22:55:45.302Z')).toBe('2026-09-04 22:55 UTC');
  });

  it('says so rather than inventing a date', () => {
    expect(isoDay('not a date')).toBe('unknown date');
  });

  it('renders an hour window with its zone, wrapping past midnight', () => {
    expect(hourWindow(18, 26)).toBe('18:00-02:00 UTC');
  });

  it('renders a UTC offset with its sign', () => {
    expect(utcOffset(6)).toBe('UTC+6');
    expect(utcOffset(-5)).toBe('UTC-5');
    expect(utcOffset(0)).toBe('UTC');
  });
});

describe('wrap', () => {
  it('never breaks a word', () => {
    const lines = wrap('the quietest eight hours of the day are a night', 12);
    expect(lines.every((line) => line.length <= 12)).toBe(true);
    expect(lines.join(' ')).toBe('the quietest eight hours of the day are a night');
  });

  it('returns one empty line for empty input, so callers never render undefined', () => {
    expect(wrap('   ', 20)).toEqual(['']);
  });
});
