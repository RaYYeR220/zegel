import type { ChainId } from './sdk.js';

/**
 * Mobula is not internally consistent about chain identifiers.
 *
 * Observed live on 2026-09-03 against `demo-api.mobula.io`:
 *   - request filter        `chainIds=evm:8453`, `chainIds=solana`
 *   - token objects         `chainId: "evm:8453"`, `chainId: "solana:solana"`
 *   - `/2/wallet/trades`    `blockchain: "Ethereum"` / `"Base"` — display names
 *   - `/2/wallet/funding`   `chainId: "evm:1"`, `chainId: "solana:solana"`
 *   - GraphQL               integer `networkId` (1, 8453, Solana = 1399811149)
 *
 * Everything inside this package is normalised to the canonical form used by the
 * Zegel wire types — `evm:<decimal chain id>` or `solana` — before it is compared
 * or grouped. Raw response bodies are never rewritten: they are kept verbatim so
 * a verifier re-derives from exactly what the upstream returned.
 */

export const CANONICAL_CHAINS = ['evm:1', 'evm:8453', 'solana'] as const;

/** Display names seen in `blockchain` fields, lowercased. */
const DISPLAY_NAMES: Readonly<Record<string, ChainId>> = {
  ethereum: 'evm:1',
  'ethereum mainnet': 'evm:1',
  base: 'evm:8453',
  solana: 'solana',
  optimism: 'evm:10',
  'bnb smart chain': 'evm:56',
  bnb: 'evm:56',
  bsc: 'evm:56',
  polygon: 'evm:137',
  arbitrum: 'evm:42161',
  'arbitrum one': 'evm:42161',
  avalanche: 'evm:43114',
  gnosis: 'evm:100',
  xdai: 'evm:100',
};

/** GraphQL integer network ids that are not EVM chain ids. */
const NUMERIC_NON_EVM: Readonly<Record<string, ChainId>> = {
  '1399811149': 'solana',
};

/**
 * Fold any of Mobula's chain spellings into the canonical Zegel form.
 * Returns `null` for input we cannot place, which callers must treat as
 * "unknown chain" rather than guessing.
 */
export function normalizeChain(raw: string | number | null | undefined): ChainId | null {
  if (raw === null || raw === undefined) return null;
  const s = String(raw).trim();
  if (s === '') return null;

  const lower = s.toLowerCase();

  // `solana`, `solana:solana`, `solana:mainnet`
  if (lower === 'solana' || lower.startsWith('solana:')) return 'solana';

  // `evm:1`
  if (lower.startsWith('evm:')) {
    const id = lower.slice(4);
    return /^\d+$/.test(id) ? `evm:${Number(id)}` : null;
  }

  // bare integer — GraphQL `networkId`, or `chainId: "1"`
  if (/^\d+$/.test(lower)) {
    const nonEvm = NUMERIC_NON_EVM[lower];
    if (nonEvm !== undefined) return nonEvm;
    return `evm:${Number(lower)}`;
  }

  return DISPLAY_NAMES[lower] ?? null;
}

/** The query-parameter spelling Mobula's REST filters accept for a canonical chain. */
export function toQueryChain(chain: ChainId): string {
  return chain === 'solana' ? 'solana' : chain;
}

/** Stable ordering so derived output does not depend on request scheduling. */
export function compareChains(a: ChainId, b: ChainId): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
