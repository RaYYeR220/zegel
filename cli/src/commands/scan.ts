/**
 * `zegel scan` — the exposure dossier.
 *
 * Runs the real collection against live Mobula with no credentials and renders
 * what anyone can already learn about an address. This is the argument for the
 * rest of the product, so it must never be the part that is faked: if an upstream
 * fails, the gap is printed rather than filled.
 */

import { buildEvidence, createMobulaClient } from '@zegel/evidence';
import type { EvidenceBundle } from '@zegel/sdk/types';

import { analyseExposure } from '../core/exposure.js';
import { CliError, type Output } from '../core/output.js';
import { resolveSubject } from '../core/subject.js';
import { renderScan } from '../render/scan.js';

export interface ScanOptions {
  chains?: string | undefined;
  days?: number | undefined;
  maxSecurity?: number | undefined;
  concurrency?: number | undefined;
  historyLimit?: number | undefined;
  tradesLimit?: number | undefined;
  probeOptional?: boolean | undefined;
  explain?: boolean | undefined;
  rpc?: string | undefined;
  /** Write the collected bundle here, so `issue` and `verify` can reuse it. */
  out?: string | undefined;
}

export const DEFAULT_CHAINS = ['evm:1', 'evm:8453', 'solana'] as const;
export const DEFAULT_WINDOW_DAYS = 730;

export function parseChains(raw: string | undefined): string[] {
  if (raw === undefined || raw.trim() === '') return [...DEFAULT_CHAINS];
  const chains = raw
    .split(',')
    .map((c) => c.trim())
    .filter((c) => c.length > 0);
  if (chains.length === 0) throw new CliError(`--chains was given but parsed to nothing: "${raw}"`);
  return chains;
}

export async function scan(out: Output, target: string, options: ScanOptions = {}): Promise<number> {
  const theme = out.theme;
  const subject = await resolveSubject(target, { rpcUrl: options.rpc });
  const chains = parseChains(options.chains);

  const client = createMobulaClient({ retry: { maxAttempts: 2, timeoutMs: 8_000 } });
  if (!out.json) {
    out.line();
    out.line(
      `  ${theme.dim(`collecting from ${client.baseUrl}${client.hasApiKey ? ' with a key' : ' — no key, no signup'}`)}`,
    );
  }

  const started = Date.now();
  let bundle: EvidenceBundle;
  try {
    bundle = await buildEvidence(subject.address, {
      client,
      chains,
      windowDays: options.days ?? DEFAULT_WINDOW_DAYS,
      maxSecurityLookups: options.maxSecurity ?? 10,
      probeOptionalEndpoints: options.probeOptional !== false,
      concurrency: options.concurrency ?? 4,
      ...(options.historyLimit === undefined ? {} : { historyLimit: options.historyLimit }),
      ...(options.tradesLimit === undefined ? {} : { tradesLimit: options.tradesLimit }),
      onProgress: (event) => {
        out.progress(
          `[${event.done}/${event.total}] ${event.endpoint} ${event.status === 'ok' ? 'ok' : `unavailable (${event.httpStatus ?? 'no response'})`}`,
        );
      },
    });
  } catch (cause) {
    throw new CliError('evidence collection failed against Mobula', {
      cause,
      hints: ['Run `zegel doctor` to see which upstreams are answering right now.'],
    });
  }
  out.endProgress();

  const elapsedSeconds = (Date.now() - started) / 1000;
  const report = analyseExposure(bundle);

  if (options.out !== undefined) {
    const { writeFile, mkdir } = await import('node:fs/promises');
    const { dirname } = await import('node:path');
    await mkdir(dirname(options.out), { recursive: true });
    await writeFile(options.out, `${JSON.stringify(bundle, null, 2)}\n`, 'utf8');
    if (!out.json) out.line(`  ${theme.dim(`bundle written to ${options.out}`)}`);
  }

  if (out.json) {
    out.emit({
      command: 'scan',
      subject: {
        address: report.address,
        ...(subject.ensName === undefined ? {} : { ensName: subject.ensName }),
        via: subject.via,
      },
      window: report.window,
      chains: report.chains,
      collectedIn: { seconds: Number(elapsedSeconds.toFixed(2)) },
      credits: { spent: client.rateLimit.spent, latest: client.rateLimit.latest },
      metrics: report.metrics,
      clock: report.clock,
      funding: report.funding,
      venues: report.venues,
      holdings: report.holdings,
      bestAssets: report.bestAssets,
      worstAssets: report.worstAssets,
      riskiest: report.riskiest,
      linkedAddresses: report.linkedAddresses,
      labels: report.labels,
      unavailable: report.unavailable,
      claims: bundle.claims,
      provenance: report.provenance,
    });
    return 0;
  }

  out.lines(
    renderScan(theme, report, {
      ...(subject.ensName === undefined ? {} : { ensName: subject.ensName }),
      ...(options.explain === true ? { explain: true } : {}),
      elapsedSeconds,
      ...(client.rateLimit.spent > 0 ? { creditsSpent: client.rateLimit.spent } : {}),
    }),
  );

  return 0;
}
