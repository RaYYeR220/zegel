import type { MobulaClient } from './client.js';
import { normalizeChain } from './chains.js';
import type { ChainId } from './sdk.js';

/**
 * Mobula's GraphQL host answers over plain HTTP with no credentials at all,
 * which matters here specifically: the demo has to work for a reviewer with no
 * key. These two queries carry the parts of the exposure story REST does not —
 * a screener view, and the ranked realized PnL of a token's top traders, which
 * is exactly the shape the deanonymisation industry builds on.
 *
 * Shapes verified against a live introspection of the schema, not from memory:
 * `tokenTopTraders` takes a single `TokenTopTradersInput` and returns a
 * connection whose numeric fields come back as strings.
 */

/** Solana's GraphQL `networkId`. EVM chains use their decimal chain id. */
export const SOLANA_NETWORK_ID = 1_399_811_149;

export interface FilterTokensRow {
  token: { address: string; networkId: number; symbol: string; name: string | null };
  chain: ChainId | null;
  volume24: number;
  priceUSD: number;
  liquidity: number;
}

const FILTER_TOKENS = `
query ZegelFilterTokens($limit: Int!) {
  filterTokens(limit: $limit, rankings: [{ attribute: volume24, direction: DESC }]) {
    count
    results { token { address networkId symbol name } volume24 priceUSD liquidity }
  }
}`;

export async function filterTokens(
  client: Pick<MobulaClient, 'graphql'>,
  limit = 10,
): Promise<FilterTokensRow[]> {
  const data = await client.graphql<{
    filterTokens: {
      results: {
        token: { address: string; networkId: number; symbol: string; name: string | null };
        volume24: string | number | null;
        priceUSD: string | number | null;
        liquidity: string | number | null;
      }[];
    };
  }>(FILTER_TOKENS, { limit });

  return data.filterTokens.results.map((row) => ({
    token: row.token,
    chain: normalizeChain(row.token.networkId),
    volume24: Number(row.volume24 ?? 0),
    priceUSD: Number(row.priceUSD ?? 0),
    liquidity: Number(row.liquidity ?? 0),
  }));
}

export type TradingPeriod = 'DAY' | 'WEEK' | 'MONTH' | 'YEAR';

export interface TopTraderRow {
  wallet: string;
  chain: ChainId | null;
  realizedProfitUsd: number;
  volumeUsd: number;
  buys: number;
  sells: number;
}

const TOP_TRADERS = `
query ZegelTopTraders($input: TokenTopTradersInput!) {
  tokenTopTraders(input: $input) {
    items { walletAddress volumeUsd buys sells realizedProfitUsd }
  }
}`;

export interface TopTradersQuery {
  tokenAddress: string;
  networkId: number;
  tradingPeriod?: TradingPeriod | undefined;
  limit?: number | undefined;
}

export async function tokenTopTraders(
  client: Pick<MobulaClient, 'graphql'>,
  query: TopTradersQuery,
): Promise<TopTraderRow[]> {
  const data = await client.graphql<{
    tokenTopTraders: {
      items: {
        walletAddress: string;
        volumeUsd: string | number | null;
        buys: number | null;
        sells: number | null;
        realizedProfitUsd: string | number | null;
      }[];
    };
  }>(TOP_TRADERS, {
    input: {
      tokenAddress: query.tokenAddress,
      networkId: query.networkId,
      tradingPeriod: query.tradingPeriod ?? 'WEEK',
      limit: query.limit ?? 10,
    },
  });

  return data.tokenTopTraders.items.map((row) => ({
    wallet: row.walletAddress,
    chain: normalizeChain(query.networkId),
    realizedProfitUsd: Number(row.realizedProfitUsd ?? 0),
    volumeUsd: Number(row.volumeUsd ?? 0),
    buys: row.buys ?? 0,
    sells: row.sells ?? 0,
  }));
}

/** Canonical chain id to the integer `networkId` GraphQL expects. */
export function toNetworkId(chain: ChainId): number | null {
  if (chain === 'solana') return SOLANA_NETWORK_ID;
  const match = /^evm:(\d+)$/.exec(chain);
  return match?.[1] === undefined ? null : Number(match[1]);
}
