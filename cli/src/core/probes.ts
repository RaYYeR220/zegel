/**
 * Dependency probes for `zegel doctor`.
 *
 * The rule this file exists to enforce: a green tick means a request was made and
 * answered, in this process, just now. Nothing is inferred from configuration,
 * nothing is assumed from a previous run, and a probe that could not be made is
 * reported as skipped rather than passed. A capability table that lies is worse
 * than no capability table, because it is believed.
 *
 * Every unavailable capability also states what it costs, so a reader knows
 * whether to care.
 */

export type Capability = 'ok' | 'degraded' | 'unavailable' | 'not-configured';

export interface ProbeResult {
  id: string;
  /** What the capability is, in the reader's words. */
  name: string;
  status: Capability;
  /** The URL that was actually contacted, so a reader can repeat the request. */
  endpoint: string;
  /** What happened. Always factual: a status code, a parsed field, an error. */
  detail: string;
  /** What this costs you when it is not `ok`. Empty when nothing is lost. */
  cost: string;
  latencyMs: number | null;
}

export interface ProbeOptions {
  timeoutMs?: number;
  env?: Record<string, string | undefined>;
  fetch?: typeof globalThis.fetch;
  /** Also hit the three Mobula routes that are known to fail, to see if today is a good day. */
  deep?: boolean;
}

const DEFAULT_TIMEOUT = 8_000;

/**
 * Keyless public RPCs, listed in the order they are tried.
 *
 * More than one because a booth demo cannot afford to discover that today's
 * favourite endpoint is rate-limiting: these both answer `eth_chainId` with no
 * key and no signup, and the ENS lookups here are a handful of `eth_call`s.
 */
export const ETH_RPCS = ['https://ethereum-rpc.publicnode.com', 'https://eth.merkle.io'] as const;
export const BASE_RPCS = ['https://mainnet.base.org', 'https://base-rpc.publicnode.com'] as const;

export const DEFAULT_ETH_RPC = ETH_RPCS[0];
export const DEFAULT_BASE_RPC = BASE_RPCS[0];
export const DEFAULT_BEE_URL = 'http://127.0.0.1:1633';

interface RawProbe {
  ok: boolean;
  status: number | null;
  body: string;
  latencyMs: number;
  error: string | null;
}

async function request(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  doFetch: typeof globalThis.fetch,
): Promise<RawProbe> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const started = Date.now();
  try {
    const response = await doFetch(url, { ...init, signal: controller.signal });
    const body = await response.text().catch(() => '');
    return {
      ok: response.ok,
      status: response.status,
      body: body.slice(0, 4_000),
      latencyMs: Date.now() - started,
      error: null,
    };
  } catch (cause) {
    return {
      ok: false,
      status: null,
      body: '',
      latencyMs: Date.now() - started,
      error: cause instanceof Error ? cause.message : String(cause),
    };
  } finally {
    clearTimeout(timer);
  }
}

async function jsonRpc(
  url: string,
  method: string,
  timeoutMs: number,
  doFetch: typeof globalThis.fetch,
): Promise<RawProbe> {
  return request(
    url,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: [] }),
    },
    timeoutMs,
    doFetch,
  );
}

/** Runs every probe concurrently and returns them in a stable, readable order. */
export async function runProbes(options: ProbeOptions = {}): Promise<ProbeResult[]> {
  const env = options.env ?? process.env;
  const timeout = options.timeoutMs ?? DEFAULT_TIMEOUT;
  const doFetch = options.fetch ?? globalThis.fetch;

  const beeUrl = env['ZEGEL_BEE_URL'] ?? env['BEE_API_URL'] ?? DEFAULT_BEE_URL;
  const swarmUrl = env['SWARM_GATEWAY_URL'] ?? 'https://api.gateway.ethswarm.org';
  const ethRpc = env['ETH_RPC_URL'] ?? DEFAULT_ETH_RPC;
  const baseRpc = env['BASE_RPC_URL'] ?? DEFAULT_BASE_RPC;
  const apiKey = env['MOBULA_API_KEY'];

  const tasks: Promise<ProbeResult>[] = [
    mobulaDemo(timeout, doFetch),
    mobulaGraphql(timeout, doFetch),
    mobulaProd(apiKey, timeout, doFetch),
    swarmGateway(swarmUrl, timeout, doFetch),
    beeNode(beeUrl, timeout, doFetch),
    rpc('rpc-ethereum', 'Ethereum RPC (ENS resolution)', ethRpc, '0x1', timeout, doFetch),
    rpc('rpc-base', 'Base RPC (commitment anchor)', baseRpc, '0x2105', timeout, doFetch),
  ];

  if (options.deep === true) tasks.push(mobulaFlaky(timeout, doFetch));

  return Promise.all(tasks);
}

async function mobulaDemo(timeout: number, doFetch: typeof globalThis.fetch): Promise<ProbeResult> {
  const endpoint = 'https://demo-api.mobula.io/api/2/market/lighthouse';
  const r = await request(endpoint, { method: 'GET' }, timeout, doFetch);
  return {
    id: 'mobula-demo',
    name: 'Mobula demo host (no key, no signup)',
    endpoint,
    status: r.ok ? 'ok' : 'unavailable',
    detail: r.error ?? `HTTP ${r.status}`,
    cost: r.ok ? '' : 'scan and issue cannot collect evidence at all; every claim would be missing',
    latencyMs: r.latencyMs,
  };
}

async function mobulaGraphql(timeout: number, doFetch: typeof globalThis.fetch): Promise<ProbeResult> {
  const endpoint = 'https://graphql.mobula.io/graphql';
  const r = await request(
    endpoint,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: '{ __typename }' }),
    },
    timeout,
    doFetch,
  );
  return {
    id: 'mobula-graphql',
    name: 'Mobula GraphQL (open, unauthenticated)',
    endpoint,
    status: r.ok ? 'ok' : 'unavailable',
    detail: r.error ?? `HTTP ${r.status}`,
    cost: r.ok ? '' : 'the screener and top-trader views lose their data source',
    latencyMs: r.latencyMs,
  };
}

async function mobulaProd(
  apiKey: string | undefined,
  timeout: number,
  doFetch: typeof globalThis.fetch,
): Promise<ProbeResult> {
  const endpoint = 'https://api.mobula.io/api/2/market/lighthouse';
  if (apiKey === undefined || apiKey === '') {
    return {
      id: 'mobula-prod',
      name: 'Mobula production host (MOBULA_API_KEY)',
      endpoint,
      status: 'not-configured',
      detail: 'MOBULA_API_KEY is not set, so the demo host is used instead',
      cost: 'higher rate limits and WebSocket streaming are unavailable; nothing else changes',
      latencyMs: null,
    };
  }
  const r = await request(endpoint, { method: 'GET', headers: { Authorization: apiKey } }, timeout, doFetch);
  return {
    id: 'mobula-prod',
    name: 'Mobula production host (MOBULA_API_KEY)',
    endpoint,
    status: r.ok ? 'ok' : 'unavailable',
    detail: r.error ?? `HTTP ${r.status}`,
    cost: r.ok ? '' : 'the key was rejected; collection falls back to the demo host and its lower limits',
    latencyMs: r.latencyMs,
  };
}

async function mobulaFlaky(timeout: number, doFetch: typeof globalThis.fetch): Promise<ProbeResult> {
  const paths = ['/2/wallet/analysis', '/2/wallet/defi-positions', '/1/wallet/history'];
  const wallet = '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045';
  const results = await Promise.all(
    paths.map((path) =>
      request(
        `https://demo-api.mobula.io/api${path}?wallet=${wallet}`,
        { method: 'GET' },
        timeout,
        doFetch,
      ).then((r) => ({ path, r })),
    ),
  );
  const good = results.filter((x) => x.r.ok);
  return {
    id: 'mobula-flaky',
    name: 'Mobula routes known to fail upstream',
    endpoint: 'https://demo-api.mobula.io',
    status: good.length === paths.length ? 'ok' : good.length === 0 ? 'unavailable' : 'degraded',
    detail: results
      .map((x) => `${x.path} ${x.r.error === null ? `HTTP ${x.r.status}` : 'network failure'}`)
      .join('; '),
    cost:
      good.length === paths.length
        ? ''
        : 'nothing: no claim depends on these, and the bundle records them as unavailable rather than guessing',
    latencyMs: results.reduce((m, x) => Math.max(m, x.r.latencyMs), 0),
  };
}

async function swarmGateway(
  url: string,
  timeout: number,
  doFetch: typeof globalThis.fetch,
): Promise<ProbeResult> {
  const endpoint = new URL('/health', url).toString();
  const r = await request(endpoint, { method: 'GET' }, timeout, doFetch);
  return {
    id: 'swarm-gateway',
    name: 'Swarm public gateway (nodeless sealing)',
    endpoint,
    status: r.ok ? 'ok' : 'unavailable',
    detail: r.error ?? `HTTP ${r.status}${r.body === '' ? '' : ` ${r.body.trim().slice(0, 40)}`}`,
    cost: r.ok
      ? 'sealing works with no node and no tokens, but the gateway holds the publisher key: confidentiality is obscurity, not key-bound access control'
      : 'issue cannot seal anything without a local Bee node',
    latencyMs: r.latencyMs,
  };
}

async function beeNode(
  url: string,
  timeout: number,
  doFetch: typeof globalThis.fetch,
): Promise<ProbeResult> {
  const health = await request(new URL('/health', url).toString(), { method: 'GET' }, timeout, doFetch);
  if (!health.ok) {
    return {
      id: 'bee-node',
      name: 'Local Bee node (grant / revoke)',
      endpoint: url,
      status: 'unavailable',
      detail: health.error ?? `HTTP ${health.status}`,
      cost: 'grant and revoke are impossible: POST /grantee is 404 on the public gateway, and only a node we control holds the ACT publisher private key',
      latencyMs: health.latencyMs,
    };
  }

  // A gateway advertises itself here. Treating it as a node would promise
  // grantee management that 404s the moment a judge asks for it.
  const gateway = await request(new URL('/gateway', url).toString(), { method: 'GET' }, 2_000, doFetch);
  if (gateway.ok && gateway.body.includes('"gateway":true')) {
    return {
      id: 'bee-node',
      name: 'Local Bee node (grant / revoke)',
      endpoint: url,
      status: 'unavailable',
      detail: 'the endpoint answers /health but identifies itself as a gateway, not a node',
      cost: 'grant and revoke are impossible: a gateway does not expose POST /grantee',
      latencyMs: health.latencyMs,
    };
  }

  const addresses = await request(
    new URL('/addresses', url).toString(),
    { method: 'GET' },
    timeout,
    doFetch,
  );
  // The ACT publisher is `publicKey`, never `pssPublicKey` — they are different
  // keys on the same node, and the wrong one produces a grant that decrypts nothing.
  let publicKey: string | null = null;
  if (addresses.ok) {
    try {
      publicKey = (JSON.parse(addresses.body) as { publicKey?: string }).publicKey ?? null;
    } catch {
      publicKey = null;
    }
  }
  const hasPublisher = publicKey !== null && publicKey !== '';

  return {
    id: 'bee-node',
    name: 'Local Bee node (grant / revoke)',
    endpoint: url,
    status: hasPublisher ? 'ok' : 'degraded',
    detail: hasPublisher
      ? `HTTP ${health.status}, ACT publisher ${(publicKey ?? '').slice(0, 10)}…`
      : `HTTP ${health.status}, but /addresses did not report a public key (${addresses.error ?? `HTTP ${addresses.status}`})`,
    cost: hasPublisher
      ? ''
      : 'without the ACT publisher key nothing sealed here can be read back; set ZEGEL_ACT_PUBLISHER if you know it',
    latencyMs: health.latencyMs,
  };
}

async function rpc(
  id: string,
  name: string,
  url: string,
  expectedChainId: string,
  timeout: number,
  doFetch: typeof globalThis.fetch,
): Promise<ProbeResult> {
  const r = await jsonRpc(url, 'eth_chainId', timeout, doFetch);
  if (!r.ok) {
    return {
      id,
      name,
      endpoint: url,
      status: 'unavailable',
      detail: r.error ?? `HTTP ${r.status}`,
      cost:
        id === 'rpc-ethereum'
          ? 'ENS names cannot be resolved; pass a raw address instead, and verify cannot read an envelope from a name'
          : 'the on-chain commitment anchor cannot be read, so verify cannot rule out revocation',
      latencyMs: r.latencyMs,
    };
  }

  let chainId: string | null = null;
  try {
    chainId = (JSON.parse(r.body) as { result?: string }).result ?? null;
  } catch {
    chainId = null;
  }

  const matches = chainId === expectedChainId;
  return {
    id,
    name,
    endpoint: url,
    status: matches ? 'ok' : 'degraded',
    detail: matches
      ? `eth_chainId ${chainId}`
      : `eth_chainId returned ${chainId ?? 'nothing parseable'}, expected ${expectedChainId}`,
    cost: matches ? '' : 'this endpoint is answering for a different chain; results from it would be meaningless',
    latencyMs: r.latencyMs,
  };
}

/** The one-line verdict under the table. Degraded is never rounded up to fine. */
export function summarise(results: readonly ProbeResult[]): {
  ok: number;
  degraded: number;
  unavailable: number;
  notConfigured: number;
  /** True when every capability the demo path needs answered. */
  demoPathReady: boolean;
  blocking: readonly string[];
} {
  const tally = { ok: 0, degraded: 0, unavailable: 0, notConfigured: 0 };
  for (const r of results) {
    if (r.status === 'ok') tally.ok += 1;
    else if (r.status === 'degraded') tally.degraded += 1;
    else if (r.status === 'unavailable') tally.unavailable += 1;
    else tally.notConfigured += 1;
  }

  // The zero-credential demo needs Mobula's demo host and the Swarm gateway.
  // Everything else degrades into a smaller demo rather than no demo.
  const required = ['mobula-demo', 'swarm-gateway'];
  const blocking = results
    .filter((r) => required.includes(r.id) && r.status !== 'ok')
    .map((r) => r.name);

  return { ...tally, demoPathReady: blocking.length === 0, blocking };
}
