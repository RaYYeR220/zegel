/**
 * `zegel doctor` — what actually works right now.
 *
 * Every row is a request made in this process, seconds ago. The exit code follows
 * the two capabilities the zero-credential demo genuinely needs, so this command
 * is usable as a pre-flight check in a script and not only as something to read.
 */

import { runProbes, summarise, type ProbeResult } from '../core/probes.js';
import type { Output } from '../core/output.js';
import { renderCapabilities } from '../render/capability.js';
import { banner, section } from '../render/layout.js';

export interface DoctorOptions {
  deep?: boolean;
  timeout?: number;
}

export async function doctor(out: Output, options: DoctorOptions = {}): Promise<number> {
  const theme = out.theme;
  out.lines(banner(theme, 'zegel doctor', 'probing every dependency, live, right now'));
  out.progress('probing upstreams…');

  const results = await runProbes({
    ...(options.timeout === undefined ? {} : { timeoutMs: options.timeout }),
    ...(options.deep === true ? { deep: true } : {}),
  });
  out.endProgress();

  const tally = summarise(results);

  if (out.json) {
    out.emit({
      command: 'doctor',
      checkedAt: new Date().toISOString(),
      capabilities: results,
      summary: tally,
    });
    return tally.demoPathReady ? 0 : 1;
  }

  out.line();
  out.lines(renderCapabilities(theme, results));

  out.lines(section(theme, 'verdict'));
  const parts = [
    theme.good(`${tally.ok} working`),
    tally.degraded > 0 ? theme.warn(`${tally.degraded} degraded`) : null,
    tally.unavailable > 0 ? theme.bad(`${tally.unavailable} unavailable`) : null,
    tally.notConfigured > 0 ? theme.dim(`${tally.notConfigured} not set up`) : null,
  ].filter((p): p is string => p !== null);
  out.line(`  ${parts.join(theme.dim(' · '))}`);
  out.line();

  if (tally.demoPathReady) {
    out.line(`  ${theme.good(theme.glyphs.pass)} The zero-credential path is available: scan and issue will run.`);
  } else {
    out.line(`  ${theme.bad(theme.glyphs.fail)} The zero-credential path is blocked by: ${tally.blocking.join(', ')}.`);
  }
  out.line(
    `  ${theme.dim('Grant and revoke need a Bee node; they are refused, not faked, when one is absent.')}`,
  );
  out.line();

  return tally.demoPathReady ? 0 : 1;
}

export type { ProbeResult };
