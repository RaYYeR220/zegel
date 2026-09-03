/**
 * Terminal styling.
 *
 * Colour is a rendering detail, never a carrier of meaning: every status that is
 * painted also says what it is in words, so a pipe, a log file or a colour-blind
 * reader loses nothing. `NO_COLOR` is honoured unconditionally — it is a promise
 * a tool makes to its user, not a preference to weigh against a nicer demo.
 */

export interface ThemeOptions {
  /** Force colour on or off. Unset means "decide from the environment". */
  color?: boolean | undefined;
  /** Force ASCII-only box drawing. */
  ascii?: boolean | undefined;
  stream?: { isTTY?: boolean; columns?: number } | undefined;
  env?: Record<string, string | undefined> | undefined;
}

export interface Glyphs {
  readonly topLeft: string;
  readonly topRight: string;
  readonly bottomLeft: string;
  readonly bottomRight: string;
  readonly horizontal: string;
  readonly vertical: string;
  readonly teeLeft: string;
  readonly teeRight: string;
  readonly pass: string;
  readonly fail: string;
  readonly warn: string;
  readonly bullet: string;
  readonly arrow: string;
  readonly blockFull: string;
  readonly blockEmpty: string;
}

const UNICODE: Glyphs = {
  topLeft: '┌',
  topRight: '┐',
  bottomLeft: '└',
  bottomRight: '┘',
  horizontal: '─',
  vertical: '│',
  teeLeft: '├',
  teeRight: '┤',
  pass: '✓',
  fail: '✗',
  warn: '!',
  bullet: '•',
  arrow: '→',
  blockFull: '█',
  blockEmpty: '░',
};

const ASCII: Glyphs = {
  topLeft: '+',
  topRight: '+',
  bottomLeft: '+',
  bottomRight: '+',
  horizontal: '-',
  vertical: '|',
  teeLeft: '+',
  teeRight: '+',
  pass: 'PASS',
  fail: 'FAIL',
  warn: '!',
  bullet: '*',
  arrow: '->',
  blockFull: '#',
  blockEmpty: '.',
};

const ESC = String.fromCharCode(27);

const CODES = {
  reset: 0,
  bold: 1,
  dim: 2,
  red: 31,
  green: 32,
  yellow: 33,
  blue: 34,
  magenta: 35,
  cyan: 36,
  white: 37,
  grey: 90,
} as const;

export type StyleName = keyof typeof CODES;

export interface Theme {
  readonly color: boolean;
  readonly unicode: boolean;
  readonly width: number;
  readonly glyphs: Glyphs;
  paint(text: string, ...styles: StyleName[]): string;
  bold(text: string): string;
  dim(text: string): string;
  good(text: string): string;
  bad(text: string): string;
  warn(text: string): string;
  key(text: string): string;
  accent(text: string): string;
}

/**
 * Decides colour the way the ecosystem has settled on it.
 *
 * `NO_COLOR` wins over everything except an explicit flag, `FORCE_COLOR` turns it
 * back on for a CI log, and otherwise a non-TTY gets plain text — piping into
 * `jq` or a file should not produce escape sequences nobody asked for.
 */
export function shouldColor(
  env: Record<string, string | undefined>,
  stream: { isTTY?: boolean } | undefined,
  override?: boolean,
): boolean {
  if (override !== undefined) return override;
  if (env['NO_COLOR'] !== undefined && env['NO_COLOR'] !== '') return false;
  if (env['FORCE_COLOR'] !== undefined && env['FORCE_COLOR'] !== '0') return true;
  if (env['TERM'] === 'dumb') return false;
  return stream?.isTTY === true;
}

export function createTheme(options: ThemeOptions = {}): Theme {
  const env = options.env ?? process.env;
  const stream = options.stream ?? process.stdout;
  const color = shouldColor(env, stream, options.color);
  const unicode = !(options.ascii ?? (env['ZEGEL_ASCII'] !== undefined && env['ZEGEL_ASCII'] !== ''));
  const glyphs = unicode ? UNICODE : ASCII;

  const rawWidth = typeof stream.columns === 'number' && stream.columns > 0 ? stream.columns : 80;
  const width = Math.max(60, Math.min(rawWidth, 100));

  const paint = (text: string, ...styles: StyleName[]): string => {
    if (!color || styles.length === 0) return text;
    const open = styles.map((s) => `${ESC}[${CODES[s]}m`).join('');
    return `${open}${text}${ESC}[${CODES.reset}m`;
  };

  return {
    color,
    unicode,
    width,
    glyphs,
    paint,
    bold: (t) => paint(t, 'bold'),
    dim: (t) => paint(t, 'grey'),
    good: (t) => paint(t, 'green'),
    bad: (t) => paint(t, 'red'),
    warn: (t) => paint(t, 'yellow'),
    key: (t) => paint(t, 'cyan'),
    accent: (t) => paint(t, 'magenta'),
  };
}

/** A theme that never colours and always uses ASCII. The default for tests. */
export function plainTheme(width = 80): Theme {
  return createTheme({ color: false, ascii: true, stream: { isTTY: false, columns: width }, env: {} });
}
