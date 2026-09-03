/**
 * Turning what a person typed into an address to scan.
 *
 * An ENS name is normalised through ENSIP-15 before it is hashed — skipping that
 * step is how homograph lookalikes resolve to somebody else's wallet, and it is
 * one line to get right.
 */

import { createPublicClient, fallback, getAddress, http, isAddress, type PublicClient } from 'viem';
import { mainnet } from 'viem/chains';
import { normalize } from 'viem/ens';

import { CliError } from './output.js';
import { DEFAULT_ETH_RPC, ETH_RPCS } from './probes.js';

export interface Subject {
  /** Checksummed EVM address, or a Solana address verbatim. */
  address: string;
  /** Set when the input was a name that resolved. */
  ensName?: string;
  /** How it was obtained, for the provenance line. */
  via: 'literal' | 'ens';
  /** The RPC that answered, when a name was resolved. */
  rpcUrl?: string;
}

const SOLANA_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export function looksLikeName(input: string): boolean {
  return input.includes('.') && !input.startsWith('0x');
}

/**
 * A mainnet client with bounded patience.
 *
 * The explicit timeout and retry cap matter more than they look: a rate-limited
 * public RPC otherwise turns a name lookup into a two-minute hang with no output,
 * which on stage is indistinguishable from a crash. One named URL is used alone —
 * if the operator picked it, second-guessing them by silently querying somewhere
 * else would be worse than failing.
 */
export function ethClient(rpcUrl?: string): PublicClient {
  const options = { timeout: 12_000, retryCount: 1 } as const;
  const transport =
    rpcUrl === undefined
      ? fallback(ETH_RPCS.map((url) => http(url, options)))
      : http(rpcUrl, options);
  return createPublicClient({ chain: mainnet, transport }) as PublicClient;
}

/**
 * Resolves an address or an ENS name.
 *
 * A name that resolves to nothing is an error, never a silent fallback to
 * treating the name as an address — the scan that follows would be of a wallet
 * nobody asked about.
 */
export async function resolveSubject(
  input: string,
  options: { rpcUrl?: string | undefined; client?: PublicClient | undefined } = {},
): Promise<Subject> {
  const trimmed = input.trim();

  if (isAddress(trimmed)) return { address: getAddress(trimmed), via: 'literal' };

  if (!looksLikeName(trimmed)) {
    if (SOLANA_ADDRESS.test(trimmed)) return { address: trimmed, via: 'literal' };
    throw new CliError(`"${trimmed}" is neither an address nor an ENS name`, {
      hints: [
        'An EVM address is 0x followed by 40 hex characters.',
        'An ENS name contains a dot, for example vitalik.eth.',
      ],
    });
  }

  const rpcUrl = options.rpcUrl;
  const client = options.client ?? ethClient(rpcUrl);

  let name: string;
  try {
    name = normalize(trimmed);
  } catch (cause) {
    throw new CliError(`"${trimmed}" is not a valid ENS name under ENSIP-15`, { cause });
  }

  let resolved: string | null;
  try {
    resolved = await client.getEnsAddress({ name });
  } catch (cause) {
    throw new CliError(`could not reach the Ethereum RPC at ${rpcUrl ?? ETH_RPCS.join(' or ')}`, {
      cause,
      hints: [
        'ENS resolution needs a mainnet RPC. Set ETH_RPC_URL to one you trust.',
        'Or pass the address directly and skip resolution entirely.',
      ],
    });
  }

  if (resolved === null) {
    throw new CliError(`${name} does not resolve to an address`, {
      hints: ['The name may be unregistered, expired, or have no address record set.'],
    });
  }

  return {
    address: getAddress(resolved),
    ensName: name,
    via: 'ens',
    ...(rpcUrl === undefined ? {} : { rpcUrl }),
  };
}
