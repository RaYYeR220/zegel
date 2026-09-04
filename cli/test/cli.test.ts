import { PassThrough } from 'node:stream';

import { describe, expect, it } from 'vitest';

import { CliError, createOutput } from '../src/core/output.js';
import { summarise, type ProbeResult } from '../src/core/probes.js';
import { DEFAULT_CHAINS, parseChains } from '../src/commands/scan.js';
import { buildProgram } from '../src/main.js';
import { looksLikeName } from '../src/core/subject.js';

function capture(): {
  stream: NodeJS.WriteStream;
  text: () => string;
} {
  const chunks: string[] = [];
  const stream = new PassThrough() as unknown as NodeJS.WriteStream;
  stream.write = ((chunk: string) => {
    chunks.push(String(chunk));
    return true;
  }) as NodeJS.WriteStream['write'];
  return { stream, text: () => chunks.join('') };
}

describe('argument parsing', () => {
  it('defaults to the three chains the product is built around', () => {
    expect(parseChains(undefined)).toEqual([...DEFAULT_CHAINS]);
    expect(parseChains('')).toEqual([...DEFAULT_CHAINS]);
  });

  it('splits and trims an explicit chain list', () => {
    expect(parseChains(' evm:1 , solana ')).toEqual(['evm:1', 'solana']);
  });

  it('refuses a chain list that parses to nothing', () => {
    expect(() => parseChains(',,')).toThrow(CliError);
  });

  it('tells an ENS name from an address without a network call', () => {
    expect(looksLikeName('vitalik.eth')).toBe(true);
    expect(looksLikeName('alice.zegel.eth')).toBe(true);
    expect(looksLikeName('0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045')).toBe(false);
  });

  it('does not mistake a file path for a name, however many dots it has', () => {
    expect(looksLikeName('.zegel/envelope.json')).toBe(false);
    expect(looksLikeName('envelope.json')).toBe(false);
    expect(looksLikeName('fixtures/anchored-reference.json')).toBe(false);
    expect(looksLikeName('C:\refs\envelope.json')).toBe(false);
  });
});

describe('the command surface', () => {
  const program = buildProgram();
  const names = program.commands.map((c) => c.name());

  it('exposes every command the product promises', () => {
    for (const name of ['scan', 'issue', 'verify', 'grant', 'revoke', 'doctor']) {
      expect(names).toContain(name);
    }
  });

  it('offers --json on every command, so nothing is terminal-only', () => {
    for (const command of program.commands) {
      if (command.name() === 'help') continue;
      const merged = [...command.options, ...program.options].map((o) => o.long);
      expect(merged).toContain('--json');
    }
  });

  it('honours --no-color as a global flag', () => {
    expect(program.options.map((o) => o.long)).toContain('--no-color');
  });

  it('gives verify the flags a real verification needs', () => {
    const verify = program.commands.find((c) => c.name() === 'verify');
    const longs = verify?.options.map((o) => o.long) ?? [];
    expect(longs).toEqual(
      expect.arrayContaining(['--claims', '--anchor', '--anchor-rpc', '--skip-anchor', '--open', '--rpc']),
    );
  });

  it('rejects a non-numeric count rather than coercing it to NaN', () => {
    const scan = program.commands.find((c) => c.name() === 'scan');
    const days = scan?.options.find((o) => o.long === '--days');
    expect(() => days?.parseArg?.('lots', undefined)).toThrow(CliError);
    expect(days?.parseArg?.('90', undefined)).toBe(90);
  });
});

describe('output plumbing', () => {
  it('writes nothing but the JSON document to stdout in JSON mode', () => {
    const stdout = capture();
    const stderr = capture();
    const out = createOutput({ json: true, stdout: stdout.stream, stderr: stderr.stream });
    out.line('a human line that must not appear');
    out.lines(['nor this one']);
    out.emit({ command: 'doctor', ok: true });
    out.flush();

    expect(JSON.parse(stdout.text())).toEqual({ command: 'doctor', ok: true });
  });

  it('writes human output to stdout and warnings to stderr', () => {
    const stdout = capture();
    const stderr = capture();
    const out = createOutput({ stdout: stdout.stream, stderr: stderr.stream, color: false });
    out.line('visible');
    out.warn('degraded');

    expect(stdout.text()).toBe('visible\n');
    expect(stderr.text()).toContain('degraded');
  });

  it('suppresses progress when stderr is not a terminal', () => {
    const stdout = capture();
    const stderr = capture();
    const out = createOutput({ stdout: stdout.stream, stderr: stderr.stream, color: false });
    out.progress('collecting…');
    out.endProgress();
    expect(stderr.text()).toBe('');
  });

  it('emits nothing at all when JSON mode was asked for but nothing was emitted', () => {
    const stdout = capture();
    const out = createOutput({ json: true, stdout: stdout.stream, stderr: capture().stream });
    out.flush();
    expect(stdout.text()).toBe('');
  });

  it('carries an exit code and hints on a CLI failure', () => {
    const error = new CliError('no Bee node', { exitCode: 3, hints: ['start one'] });
    expect(error.exitCode).toBe(3);
    expect(error.hints).toEqual(['start one']);
  });

  it('defaults a failure to exit 1', () => {
    expect(new CliError('boom').exitCode).toBe(1);
  });
});

describe('probe summary', () => {
  const probe = (id: string, status: ProbeResult['status']): ProbeResult => ({
    id,
    name: id,
    status,
    endpoint: 'https://example.invalid',
    detail: '',
    cost: '',
    latencyMs: 1,
  });

  it('calls the zero-credential path ready only when both its dependencies answer', () => {
    const ready = summarise([probe('mobula-demo', 'ok'), probe('swarm-gateway', 'ok')]);
    expect(ready.demoPathReady).toBe(true);
    expect(ready.blocking).toEqual([]);
  });

  it('names what is blocking the demo path', () => {
    const blocked = summarise([probe('mobula-demo', 'unavailable'), probe('swarm-gateway', 'ok')]);
    expect(blocked.demoPathReady).toBe(false);
    expect(blocked.blocking).toEqual(['mobula-demo']);
  });

  it('does not round a degraded capability up to working', () => {
    const blocked = summarise([probe('mobula-demo', 'degraded'), probe('swarm-gateway', 'ok')]);
    expect(blocked.demoPathReady).toBe(false);
    expect(blocked.degraded).toBe(1);
    expect(blocked.ok).toBe(1);
  });

  it('counts an unconfigured capability separately from a broken one', () => {
    const tally = summarise([probe('mobula-prod', 'not-configured'), probe('bee-node', 'unavailable')]);
    expect(tally.notConfigured).toBe(1);
    expect(tally.unavailable).toBe(1);
  });
});
