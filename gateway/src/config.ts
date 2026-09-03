import { createPublicClient, getAddress, http, isAddress, isHex, type Address, type Hex, type PublicClient } from 'viem';
import { generatePrivateKey } from 'viem/accounts';

import { ENVELOPE_SCHEMA } from '../../packages/sdk/src/types.ts';

import { createSigner, type ResponseSigner } from './signing.ts';
import { chainOwners, staticOwners, type OwnerLookup } from './owner.ts';
import { MemoryEnvelopeStore } from './store/memory.ts';
import type { EnvelopeStore } from './store/types.ts';

/**
 * How long a signed response stays valid on chain.
 *
 * The response is a bearer token: anyone holding it can feed it back through
 * `resolveWithProof` and get the same answer until it expires. Since the payload is
 * public metadata that costs us nothing to hand out, the exposure is not
 * confidentiality but *staleness* — a revoked or superseded envelope stays
 * resolvable for the length of this window. One minute is the trade: short enough
 * that a revocation announced on stage is visible before anyone finishes clapping,
 * long enough to survive an RPC round trip and a few seconds of clock skew between
 * the gateway and a validator. Below roughly 30 seconds, skew starts producing
 * `SignatureExpired` on responses that were fine when they were minted.
 */
export const DEFAULT_SIGNATURE_TTL_SECONDS = 60;

/** HTTP caching is capped by the signature: a cached response outliving its own signature is dead weight. */
export const DEFAULT_CACHE_TTL_SECONDS = 30;

export const DEFAULT_STORE_PATH = '.zegel/envelopes.json';

export interface GatewayConfig {
  readonly signer: ResponseSigner;
  readonly store: EnvelopeStore;
  readonly owners: OwnerLookup;
  /** Resolvers this gateway will sign for. Empty means unrestricted, and `/health` says so. */
  readonly resolvers: readonly Address[];
  /** Chain the resolver lives on. Binds the EIP-712 publish domain. */
  readonly chainId: number;
  readonly signatureTtlSeconds: number;
  readonly cacheTtlSeconds: number;
  /** The ENSIP-24 key served. Anything else is a 404. */
  readonly envelopeKey: string;
  /** Present only when an RPC URL is configured; used for health probes and ERC-1271. */
  readonly client: PublicClient | null;
  /** Host of the RPC endpoint, for health output. Never the full URL — those carry keys. */
  readonly rpcLabel: string | null;
  /** True when the signing key was generated at boot and no deployed resolver can know it. */
  readonly ephemeralSigner: boolean;
  readonly warnings: readonly string[];
  /** Epoch seconds. Injectable so expiry behaviour is testable without sleeping. */
  readonly now: () => number;
}

export interface GatewayConfigInput extends Partial<GatewayConfig> {
  readonly signer: ResponseSigner;
  readonly store?: EnvelopeStore;
}

/** Fills the defaults. Used by the tests and by `loadConfig`. */
export function defineConfig(input: GatewayConfigInput): GatewayConfig {
  const signatureTtlSeconds = input.signatureTtlSeconds ?? DEFAULT_SIGNATURE_TTL_SECONDS;
  return {
    signer: input.signer,
    store: input.store ?? new MemoryEnvelopeStore(),
    owners: input.owners ?? staticOwners([]),
    // Checksummed on the way in: a resolver address arrives from a URL path, an env
    // var and a transaction receipt, and those three do not agree on case.
    resolvers: (input.resolvers ?? []).map((address) => getAddress(address)),
    chainId: input.chainId ?? 1,
    signatureTtlSeconds,
    cacheTtlSeconds: Math.min(input.cacheTtlSeconds ?? DEFAULT_CACHE_TTL_SECONDS, signatureTtlSeconds),
    envelopeKey: input.envelopeKey ?? ENVELOPE_SCHEMA,
    client: input.client ?? null,
    rpcLabel: input.rpcLabel ?? null,
    ephemeralSigner: input.ephemeralSigner ?? false,
    warnings: input.warnings ?? [],
    now: input.now ?? (() => Math.floor(Date.now() / 1000)),
  };
}

export interface LoadOptions {
  /** Injected so the Worker entry can pass its own bindings instead of `process.env`. */
  readonly env: Record<string, string | undefined>;
  /** Supplied by the Node entry, which is the only place a filesystem exists. */
  readonly store?: EnvelopeStore;
}

/**
 * Builds a config from environment variables.
 *
 * Nothing here fails silently. A missing signing key in development produces a
 * throwaway key *and* a warning that surfaces in `/health` as `degraded`, because a
 * gateway signing with a key no resolver allowlists is not working — it is producing
 * responses that will be rejected on chain, which is worse than not answering.
 */
export function loadConfig(options: LoadOptions): GatewayConfig {
  const env = options.env;
  const warnings: string[] = [];

  const configuredKey = env['ZEGEL_SIGNER_KEY'];
  let privateKey: Hex;
  let ephemeralSigner = false;
  if (configuredKey && isHex(configuredKey) && configuredKey.length === 66) {
    privateKey = configuredKey;
  } else {
    if (configuredKey) throw new Error('ZEGEL_SIGNER_KEY is not a 32-byte 0x-prefixed hex private key');
    if (env['NODE_ENV'] === 'production') {
      throw new Error('ZEGEL_SIGNER_KEY is required when NODE_ENV=production');
    }
    privateKey = generatePrivateKey();
    ephemeralSigner = true;
    warnings.push(
      'ZEGEL_SIGNER_KEY is unset, so a throwaway signing key was generated at boot. ' +
        'No deployed resolver allowlists it; every response will be rejected on chain until ' +
        'setSigner() names this address, and the address changes on restart.',
    );
  }

  const resolvers = splitList(env['ZEGEL_RESOLVERS']).map((value) => {
    if (!isAddress(value)) throw new Error(`ZEGEL_RESOLVERS contains "${value}", which is not an address`);
    return getAddress(value);
  });
  if (resolvers.length === 0) {
    warnings.push(
      'ZEGEL_RESOLVERS is unset, so this gateway will sign a response for any resolver address ' +
        'that asks. Set it to the deployed ZegelResolver to refuse the rest.',
    );
  }

  const rpcUrl = env['ZEGEL_RPC_URL'];
  const client = rpcUrl
    ? (createPublicClient({ transport: http(rpcUrl) }) as unknown as PublicClient)
    : null;
  if (!client) {
    warnings.push(
      'ZEGEL_RPC_URL is unset. Name ownership cannot be read from chain and the on-chain signer ' +
        'allowlist cannot be checked, so /health reports those probes as skipped rather than passing.',
    );
  }

  const nameWrapperRaw = env['ZEGEL_NAME_WRAPPER'];
  if (nameWrapperRaw && !isAddress(nameWrapperRaw)) {
    throw new Error('ZEGEL_NAME_WRAPPER is not an address');
  }
  const registryRaw = env['ZEGEL_ENS_REGISTRY'];
  if (registryRaw && !isAddress(registryRaw)) {
    throw new Error('ZEGEL_ENS_REGISTRY is not an address');
  }

  const owners: OwnerLookup = client
    ? chainOwners({
        client,
        ...(registryRaw ? { registry: getAddress(registryRaw) } : {}),
        nameWrapper: nameWrapperRaw ? getAddress(nameWrapperRaw) : null,
      })
    : staticOwners(parseOwnerMap(env['ZEGEL_NAME_OWNERS']));

  const signatureTtlSeconds = positiveInt(env['ZEGEL_SIGNATURE_TTL'], DEFAULT_SIGNATURE_TTL_SECONDS);
  const cacheTtlSeconds = Math.min(
    positiveInt(env['ZEGEL_CACHE_TTL'], DEFAULT_CACHE_TTL_SECONDS),
    signatureTtlSeconds,
  );

  return defineConfig({
    signer: createSigner(privateKey),
    ...(options.store ? { store: options.store } : {}),
    owners,
    resolvers,
    chainId: positiveInt(env['ZEGEL_CHAIN_ID'], 1),
    signatureTtlSeconds,
    cacheTtlSeconds,
    envelopeKey: env['ZEGEL_ENVELOPE_KEY'] ?? ENVELOPE_SCHEMA,
    client,
    rpcLabel: rpcUrl ? safeHost(rpcUrl) : null,
    ephemeralSigner,
    warnings,
  });
}

function splitList(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function parseOwnerMap(value: string | undefined): Array<readonly [Hex, Address]> {
  return splitList(value).map((entry) => {
    const [node, owner] = entry.split('=').map((part) => part.trim());
    if (!node || !owner || !isHex(node) || node.length !== 66 || !isAddress(owner)) {
      throw new Error(`ZEGEL_NAME_OWNERS entry "${entry}" is not <node>=<address>`);
    }
    return [node, getAddress(owner)] as const;
  });
}

function positiveInt(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`expected a positive integer, got "${value}"`);
  }
  return parsed;
}

/** RPC URLs routinely carry an API key in the path. Only the host is ever reported. */
function safeHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return 'unparseable RPC URL';
  }
}
