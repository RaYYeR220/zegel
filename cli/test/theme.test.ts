import { describe, expect, it } from 'vitest';

import { createTheme, plainTheme, shouldColor } from '../src/render/theme.js';

const ESC = String.fromCharCode(27);

describe('colour decisions', () => {
  it('colours a TTY by default', () => {
    expect(shouldColor({}, { isTTY: true })).toBe(true);
  });

  it('does not colour a pipe', () => {
    expect(shouldColor({}, { isTTY: false })).toBe(false);
  });

  it('honours NO_COLOR even on a TTY', () => {
    expect(shouldColor({ NO_COLOR: '1' }, { isTTY: true })).toBe(false);
  });

  it('honours NO_COLOR set to any non-empty value, per the convention', () => {
    expect(shouldColor({ NO_COLOR: 'anything' }, { isTTY: true })).toBe(false);
  });

  it('ignores an empty NO_COLOR, which is how shells unset it', () => {
    expect(shouldColor({ NO_COLOR: '' }, { isTTY: true })).toBe(true);
  });

  it('lets FORCE_COLOR turn colour on for a pipe', () => {
    expect(shouldColor({ FORCE_COLOR: '1' }, { isTTY: false })).toBe(true);
  });

  it('treats FORCE_COLOR=0 as off', () => {
    expect(shouldColor({ FORCE_COLOR: '0' }, { isTTY: true })).toBe(true);
  });

  it('refuses colour on a dumb terminal', () => {
    expect(shouldColor({ TERM: 'dumb' }, { isTTY: true })).toBe(false);
  });

  it('lets an explicit flag beat NO_COLOR in both directions', () => {
    expect(shouldColor({ NO_COLOR: '1' }, { isTTY: true }, true)).toBe(true);
    expect(shouldColor({}, { isTTY: true }, false)).toBe(false);
  });
});

describe('theme output', () => {
  it('emits no escape sequences when colour is off', () => {
    const theme = plainTheme();
    const painted = `${theme.good('ok')}${theme.bad('no')}${theme.dim('meh')}${theme.bold('hi')}`;
    expect(painted).toBe('oknomehhi');
    expect(painted.includes(ESC)).toBe(false);
  });

  it('wraps text in a reset when colour is on', () => {
    const theme = createTheme({ color: true, env: {}, stream: { isTTY: true, columns: 80 } });
    expect(theme.good('ok')).toBe(`${ESC}[32mok${ESC}[0m`);
  });

  it('degrades box drawing to ASCII on request', () => {
    const theme = plainTheme();
    expect(theme.glyphs.horizontal).toBe('-');
    expect(theme.glyphs.pass).toBe('PASS');
  });

  it('keeps Unicode glyphs when ASCII is not forced', () => {
    const theme = createTheme({ color: false, env: {}, stream: { isTTY: false, columns: 80 } });
    expect(theme.glyphs.horizontal).toBe('─');
  });

  it('switches to ASCII from the environment', () => {
    const theme = createTheme({ env: { ZEGEL_ASCII: '1' }, stream: { isTTY: false } });
    expect(theme.unicode).toBe(false);
  });

  it('clamps the width to something a dossier is readable at', () => {
    expect(createTheme({ env: {}, stream: { isTTY: true, columns: 300 } }).width).toBe(100);
    expect(createTheme({ env: {}, stream: { isTTY: true, columns: 20 } }).width).toBe(60);
  });
});
