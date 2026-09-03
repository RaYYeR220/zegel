/**
 * The capability table.
 *
 * Four states, and the fourth exists so that "you did not configure this" never
 * gets painted the same red as "this is broken". A judge reading the table should
 * be able to tell in one pass which rows are their problem and which are ours.
 */

import type { Capability, ProbeResult } from '../core/probes.js';
import { bullet, section, table } from './layout.js';
import type { Theme } from './theme.js';

export function statusWord(status: Capability): string {
  switch (status) {
    case 'ok':
      return 'works';
    case 'degraded':
      return 'degraded';
    case 'unavailable':
      return 'unavailable';
    case 'not-configured':
      return 'not set up';
  }
}

export function paintStatus(theme: Theme, status: Capability): string {
  const word = statusWord(status);
  switch (status) {
    case 'ok':
      return theme.good(`${theme.glyphs.pass} ${word}`);
    case 'degraded':
      return theme.warn(`${theme.glyphs.warn} ${word}`);
    case 'unavailable':
      return theme.bad(`${theme.glyphs.fail} ${word}`);
    case 'not-configured':
      return theme.dim(`- ${word}`);
  }
}

export function renderCapabilities(theme: Theme, results: readonly ProbeResult[]): string[] {
  const out: string[] = [];

  out.push(
    ...table(
      theme,
      [
        { header: 'capability', max: 44 },
        { header: 'state' },
        { header: 'latency', align: 'right' },
        { header: 'observed', max: 40 },
      ],
      results.map((r) => [
        r.name,
        paintStatus(theme, r.status),
        r.latencyMs === null ? theme.dim('—') : `${r.latencyMs} ms`,
        theme.dim(r.detail),
      ]),
    ),
  );

  const withCost = results.filter((r) => r.status !== 'ok' && r.cost !== '');
  if (withCost.length > 0) {
    out.push(...section(theme, 'what that costs you'));
    for (const r of withCost) {
      out.push(bullet(theme, `${theme.bold(r.name)}: ${r.cost}`));
    }
  }

  const caveats = results.filter((r) => r.status === 'ok' && r.cost !== '');
  if (caveats.length > 0) {
    out.push(...section(theme, 'works, with a caveat'));
    for (const r of caveats) {
      out.push(bullet(theme, `${theme.bold(r.name)}: ${r.cost}`));
    }
  }

  out.push('');
  out.push(`  ${theme.dim('Every row above was a live request made just now. Repeat any of them:')}`);
  for (const r of results) {
    out.push(`  ${theme.dim(`${r.id.padEnd(16)} ${r.endpoint}`)}`);
  }

  return out;
}
