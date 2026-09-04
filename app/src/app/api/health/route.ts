import { runProbes, summarise } from '@zegel/cli/probes';

import { BEE_READER_URL } from '~/lib/config';
import type { HealthReport, ProbeRow } from '~/lib/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Every row here is a request made in this process, just now.
 *
 * Nothing is inferred from configuration and nothing is carried over from a
 * previous run. A capability table that lies is worse than no capability table,
 * because it is believed — so a probe that could not be made reports as skipped,
 * never as passing.
 */
export async function GET(): Promise<Response> {
  const probes = (await runProbes({ timeoutMs: 6_000 })) as ProbeRow[];
  const reader = await probeReader();

  const all = [...probes, reader];
  const report: HealthReport = {
    probes: all,
    summary: summarise(all),
    at: new Date().toISOString(),
  };

  return Response.json(report, { headers: { 'cache-control': 'no-store' } });
}

/**
 * The second node.
 *
 * ACT decryption happens inside Bee with the grantee's own key — there is no
 * browser implementation — so showing a real grantee read means a real second
 * node. An unfunded ultra-light node is enough, because reading costs nothing,
 * but it is still a thing that has to be running.
 */
async function probeReader(): Promise<ProbeRow> {
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 4_000);
  try {
    const response = await fetch(new URL('/health', BEE_READER_URL), {
      signal: controller.signal,
      cache: 'no-store',
    });
    return {
      id: 'bee-reader',
      name: 'Second Bee node (the grantee who reads)',
      status: response.ok ? 'ok' : 'unavailable',
      endpoint: BEE_READER_URL,
      detail: `HTTP ${response.status}`,
      cost: response.ok
        ? ''
        : 'a granted read cannot be demonstrated from this deployment; grants still apply, but nothing here can open them',
      latencyMs: Date.now() - started,
    };
  } catch (cause) {
    return {
      id: 'bee-reader',
      name: 'Second Bee node (the grantee who reads)',
      status: 'unavailable',
      endpoint: BEE_READER_URL,
      detail: cause instanceof Error ? cause.message : String(cause),
      cost: 'a granted read cannot be demonstrated from this deployment; grants still apply, but nothing here can open them',
      latencyMs: Date.now() - started,
    };
  } finally {
    clearTimeout(timer);
  }
}
