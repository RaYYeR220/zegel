import { describe, expect, it } from 'vitest';

import {
  bar,
  banner,
  field,
  hourHistogram,
  padEnd,
  padStart,
  section,
  stripAnsi,
  table,
  truncate,
  visibleWidth,
} from '../src/render/layout.js';
import { createTheme, plainTheme } from '../src/render/theme.js';

const colourTheme = createTheme({ color: true, env: {}, stream: { isTTY: true, columns: 80 } });

describe('width measurement', () => {
  it('ignores escape sequences when measuring', () => {
    expect(visibleWidth(colourTheme.good('ok'))).toBe(2);
  });

  it('strips escape sequences back to plain text', () => {
    expect(stripAnsi(colourTheme.bad('nope'))).toBe('nope');
  });

  it('pads a coloured cell to its visible width, not its byte length', () => {
    const padded = padEnd(colourTheme.good('ok'), 6);
    expect(visibleWidth(padded)).toBe(6);
    expect(stripAnsi(padded)).toBe('ok    ');
  });

  it('right-aligns by visible width too', () => {
    expect(stripAnsi(padStart(colourTheme.bad('7'), 4))).toBe('   7');
  });

  it('leaves a cell wider than the column alone rather than corrupting it', () => {
    expect(padEnd('abcdef', 3)).toBe('abcdef');
  });

  it('truncates with an ellipsis and drops the styling it cannot safely cut', () => {
    expect(truncate(colourTheme.good('abcdefgh'), 4)).toBe('abc…');
  });
});

describe('table', () => {
  const theme = plainTheme();

  it('lays out a header, a rule and one line per row', () => {
    const rows = table(
      theme,
      [{ header: 'asset' }, { header: 'value', align: 'right' }],
      [
        ['YUNA', '-$8,158.75'],
        ['SPEED', '+$5.08'],
      ],
    );
    expect(rows).toHaveLength(4);
    expect(rows[0]).toBe('ASSET       VALUE');
    expect(rows[1]).toBe('-----  ----------');
    expect(rows[3]).toBe('SPEED      +$5.08');
  });

  it('sizes a column to its widest cell, header included', () => {
    const rows = table(theme, [{ header: 'chain' }], [['evm:8453']]);
    expect(visibleWidth(rows[2] ?? '')).toBe(8);
  });

  it('respects a hard column cap', () => {
    const rows = table(theme, [{ header: 'why', max: 8 }], [['a very long explanation indeed']]);
    expect(visibleWidth(rows[2] ?? '')).toBe(8);
  });

  it('keeps every row the same width when a cell is coloured', () => {
    const rows = table(
      colourTheme,
      [{ header: 'state' }, { header: 'n', align: 'right' }],
      [
        [colourTheme.good('works'), '1'],
        [colourTheme.bad('broken'), '22'],
      ],
    );
    const widths = rows.slice(2).map((row) => visibleWidth(row));
    expect(new Set(widths).size).toBe(1);
  });
});

describe('blocks', () => {
  const theme = plainTheme(60);

  it('opens a section with a blank line and a titled rule', () => {
    const rows = section(theme, 'the money');
    expect(rows[0]).toBe('');
    expect(rows[1]?.startsWith('THE MONEY ')).toBe(true);
    expect(visibleWidth(rows[1] ?? '')).toBe(60);
  });

  it('draws a banner box that closes on both sides', () => {
    const rows = banner(theme, 'zegel doctor', 'probing');
    expect(rows).toHaveLength(4);
    expect(new Set(rows.map((row) => visibleWidth(row))).size).toBe(1);
    expect(rows[0]?.startsWith('+')).toBe(true);
    expect(rows[3]?.endsWith('+')).toBe(true);
  });

  it('separates a long label from its value instead of running them together', () => {
    const line = field(theme, 'taken by front-running bots', '$0.00');
    expect(line).toContain('bots $0.00');
  });

  it('aligns short labels into a column', () => {
    expect(field(theme, 'chains', 'evm:1')).toBe(`  ${'chains'.padEnd(23)} evm:1`);
  });

  it('fills a bar proportionally and clamps out-of-range input', () => {
    expect(bar(theme, 0.5, 10)).toBe('#####.....');
    expect(bar(theme, 5, 10)).toBe('##########');
    expect(bar(theme, Number.NaN, 4)).toBe('....');
  });

  it('draws one histogram row per hour, labelled', () => {
    const counts = new Array<number>(24).fill(0);
    counts[15] = 45;
    counts[14] = 39;
    const rows = hourHistogram(theme, counts, 10);
    expect(rows).toHaveLength(24);
    expect(rows[15]).toContain('15:00');
    expect(rows[15]).toContain('45');
  });

  it('draws nothing when there is nothing to draw', () => {
    expect(hourHistogram(theme, new Array<number>(24).fill(0))).toEqual([]);
  });
});
