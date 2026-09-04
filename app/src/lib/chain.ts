import { createPublicClient, fallback, http, type PublicClient } from 'viem';
import { base, mainnet } from 'viem/chains';

import { BASE_RPCS, ETH_RPCS } from './config';

/**
 * Bounded patience, on purpose.
 *
 * A rate-limited public RPC otherwise turns a name lookup into a two-minute hang
 * with no output, which on stage is indistinguishable from a crash.
 */
const TRANSPORT = { timeout: 12_000, retryCount: 1 } as const;

let ethereum: PublicClient | null = null;
let baseChain: PublicClient | null = null;

export function ethClient(): PublicClient {
  ethereum ??= createPublicClient({
    chain: mainnet,
    transport: fallback(ETH_RPCS.map((url) => http(url, TRANSPORT))),
  }) as PublicClient;
  return ethereum;
}

export function baseClient(): PublicClient {
  baseChain ??= createPublicClient({
    chain: base,
    transport: fallback(BASE_RPCS.map((url) => http(url, TRANSPORT))),
  }) as PublicClient;
  return baseChain;
}
