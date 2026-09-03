import type { GatewayConfig } from './config.ts';

export type CheckStatus = 'ok' | 'degraded' | 'down' | 'skipped';

export interface HealthCheck {
  readonly name: string;
  readonly status: CheckStatus;
  /** Specific enough to act on. A check that cannot say what is wrong is not a check. */
  readonly detail: string;
  readonly latencyMs?: number;
}

export interface HealthReport {
  readonly status: 'ok' | 'degraded' | 'down';
  readonly service: 'zegel-gateway';
  readonly time: string;
  readonly signer: string;
  readonly checks: readonly HealthCheck[];
  readonly warnings: readonly string[];
}

const RESOLVER_ABI = [
  {
    type: 'function',
    name: 'signers',
    stateMutability: 'view',
    inputs: [{ name: 'signer', type: 'address' }],
    outputs: [{ type: 'bool' }],
  },
  {
    type: 'function',
    name: 'gatewayUrls',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'string[]' }],
  },
] as const;

/**
 * Probes every dependency and reports what it found.
 *
 * The rule this follows, and the reason it exists at all: a health endpoint that
 * returns 200 because the process is running tells you nothing you did not already
 * know from the fact that it answered. Each check below is something that can be
 * true while the process is perfectly alive and the gateway is nonetheless useless
 * — an unreadable store, a signing key the resolver does not allowlist, an RPC that
 * has stopped answering. A dependency that was not configured is reported as
 * `skipped`, never as `ok`.
 */
export async function buildHealthReport(config: GatewayConfig): Promise<HealthReport> {
  const checks: HealthCheck[] = [];

  checks.push({
    name: 'signer',
    status: config.ephemeralSigner ? 'degraded' : 'ok',
    detail: config.ephemeralSigner
      ? `${config.signer.address} was generated at boot; no deployed resolver allowlists it`
      : `signing as ${config.signer.address}`,
  });

  const store = await config.store.probe();
  checks.push({
    name: 'store',
    // Without storage there is nothing to serve, so this one is fatal.
    status: store.ok ? 'ok' : 'down',
    detail: `${store.detail}; ${store.records} envelope(s) held`,
    latencyMs: store.latencyMs,
  });

  checks.push({
    name: 'resolver-allowlist',
    status: config.resolvers.length > 0 ? 'ok' : 'degraded',
    detail:
      config.resolvers.length > 0
        ? `signing only for ${config.resolvers.join(', ')}`
        : 'unrestricted: a response will be signed for any resolver address that asks',
  });

  const owners = await config.owners.probe();
  checks.push({
    name: 'name-ownership',
    // Publishing breaks; resolution does not. Degraded, not down.
    status: owners.ok ? 'ok' : 'degraded',
    detail: `${config.owners.kind}: ${owners.detail}`,
    latencyMs: owners.latencyMs,
  });

  checks.push(await probeResolverOnChain(config));

  const worst = checks.reduce<'ok' | 'degraded' | 'down'>((current, check) => {
    if (check.status === 'down' || current === 'down') return 'down';
    if (check.status === 'degraded' || current === 'degraded') return 'degraded';
    return current;
  }, 'ok');

  return {
    status: worst,
    service: 'zegel-gateway',
    time: new Date(config.now() * 1000).toISOString(),
    signer: config.signer.address,
    checks,
    warnings: config.warnings,
  };
}

/**
 * The check worth having.
 *
 * Everything else can be green while the gateway signs with a key the resolver does
 * not trust — in which case the name does not resolve, and nothing local knows why.
 * `signers(address)` is a single `eth_call` that answers it.
 */
async function probeResolverOnChain(config: GatewayConfig): Promise<HealthCheck> {
  const resolver = config.resolvers[0];
  if (!config.client || !resolver) {
    return {
      name: 'resolver-onchain',
      status: 'skipped',
      detail: !config.client
        ? 'no ZEGEL_RPC_URL, so the on-chain signer allowlist was not checked'
        : 'no ZEGEL_RESOLVERS, so there is no resolver to check the signer against',
    };
  }

  const started = Date.now();
  try {
    const code = await config.client.getCode({ address: resolver });
    if (!code || code === '0x') {
      return {
        name: 'resolver-onchain',
        status: 'down',
        detail: `no contract code at ${resolver} via ${config.rpcLabel ?? 'the configured RPC'}`,
        latencyMs: Date.now() - started,
      };
    }

    const [allowlisted, urls] = await Promise.all([
      config.client.readContract({
        address: resolver,
        abi: RESOLVER_ABI,
        functionName: 'signers',
        args: [config.signer.address],
      }),
      config.client.readContract({ address: resolver, abi: RESOLVER_ABI, functionName: 'gatewayUrls' }),
    ]);
    const latencyMs = Date.now() - started;

    if (!allowlisted) {
      return {
        name: 'resolver-onchain',
        status: 'degraded',
        detail: `${resolver} does not allowlist ${config.signer.address}; every response signed here will revert with UnauthorizedSigner. Fix with setSigner(${config.signer.address}, true).`,
        latencyMs,
      };
    }
    if (urls.length === 0) {
      return {
        name: 'resolver-onchain',
        status: 'degraded',
        detail: `${resolver} allowlists the signer but has no gateway URLs set, so it reverts NoGatewayUrls before any lookup reaches here`,
        latencyMs,
      };
    }
    return {
      name: 'resolver-onchain',
      status: 'ok',
      detail: `${resolver} allowlists ${config.signer.address}; ${urls.length} gateway URL(s) configured`,
      latencyMs,
    };
  } catch (error) {
    return {
      name: 'resolver-onchain',
      status: 'degraded',
      detail: `RPC ${config.rpcLabel ?? ''} failed: ${error instanceof Error ? error.message : String(error)}`,
      latencyMs: Date.now() - started,
    };
  }
}
