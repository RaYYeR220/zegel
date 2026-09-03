/**
 * Output plumbing.
 *
 * Two audiences, one code path: a human reading a terminal and a script reading
 * `--json`. Nothing is written twice and nothing is written to stdout in JSON
 * mode except the single document, so `zegel scan 0x… --json | jq` works without
 * a `grep -v` in front of it. Progress and warnings go to stderr, always.
 */

import { createTheme, type Theme } from '../render/theme.js';

export interface OutputOptions {
  json?: boolean | undefined;
  color?: boolean | undefined;
  ascii?: boolean | undefined;
  quiet?: boolean | undefined;
  stdout?: NodeJS.WriteStream | undefined;
  stderr?: NodeJS.WriteStream | undefined;
}

export interface Output {
  readonly theme: Theme;
  readonly json: boolean;
  /** A line of human output. Ignored entirely in JSON mode. */
  line(text?: string): void;
  lines(rows: readonly string[]): void;
  /** The machine document. Printed once, at the end, only in JSON mode. */
  emit(payload: unknown): void;
  /** Non-fatal degradation. Always stderr, so it survives a pipe. */
  warn(text: string): void;
  /** Transient single-line progress. Erased on completion; suppressed off a TTY. */
  progress(text: string): void;
  endProgress(): void;
  flush(): void;
}

export function createOutput(options: OutputOptions = {}): Output {
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  const json = options.json === true;
  const theme = createTheme({
    ...(options.color === undefined ? {} : { color: options.color }),
    ...(options.ascii === undefined ? {} : { ascii: options.ascii }),
    stream: stdout,
  });
  const errTheme = createTheme({
    ...(options.color === undefined ? {} : { color: options.color }),
    ...(options.ascii === undefined ? {} : { ascii: options.ascii }),
    stream: stderr,
  });

  let payload: unknown;
  let emitted = false;
  let progressing = false;
  const interactive = stderr.isTTY === true && options.quiet !== true && !json;

  const clearProgress = (): void => {
    if (!progressing) return;
    stderr.write('\r' + ' '.repeat(Math.max(0, (stderr.columns ?? 80) - 1)) + '\r');
    progressing = false;
  };

  return {
    theme,
    json,
    line(text = '') {
      if (json) return;
      clearProgress();
      stdout.write(`${text}\n`);
    },
    lines(rows) {
      if (json) return;
      clearProgress();
      for (const row of rows) stdout.write(`${row}\n`);
    },
    emit(value) {
      payload = value;
      emitted = true;
    },
    warn(text) {
      clearProgress();
      stderr.write(`${errTheme.warn('warning')} ${text}\n`);
    },
    progress(text) {
      if (!interactive) return;
      const width = Math.max(20, (stderr.columns ?? 80) - 1);
      const body = text.length > width ? `${text.slice(0, width - 1)}…` : text;
      stderr.write(`\r${' '.repeat(width)}\r${errTheme.dim(body)}`);
      progressing = true;
    },
    endProgress() {
      clearProgress();
    },
    flush() {
      clearProgress();
      if (json && emitted) stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    },
  };
}

/** A failure with an exit code the caller chose deliberately. */
export class CliError extends Error {
  readonly exitCode: number;
  /** Extra lines printed under the message: what is missing, and what to do. */
  readonly hints: readonly string[];

  constructor(message: string, options: { exitCode?: number; hints?: readonly string[]; cause?: unknown } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'CliError';
    this.exitCode = options.exitCode ?? 1;
    this.hints = options.hints ?? [];
  }
}
