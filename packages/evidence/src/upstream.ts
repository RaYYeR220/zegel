/**
 * The slices of Mobula's responses this package actually reads.
 *
 * These are deliberately partial. Mobula's token objects carry ~270 fields and
 * the set moves; declaring only what the derivation consumes keeps the contract
 * honest and makes it obvious which upstream fields a claim depends on. Raw
 * bodies are stored verbatim regardless — a verifier re-derives from those, not
 * from these interfaces.
 */

export interface Paginated<T> {
  data: T[];
  pagination?: {
    total?: number;
    page?: number;
    offset?: number;
    limit?: number;
    pageEntries?: number;
  };
}

export interface UpstreamToken {
  address?: string;
  /** `evm:1`, `evm:8453`, `solana:solana` — see `chains.ts`. */
  chainId?: string;
  symbol?: string;
  name?: string;
  /** Mobula's cross-chain asset id; the same integer on every chain. */
  id?: number;
}

/** One closed (or still-open) trade cycle from `/2/wallet/positions-history`. */
export interface PositionCycle {
  isOpen: boolean;
  /** ISO 8601. */
  entryDate: string | null;
  /** ISO 8601. Null while the cycle is open. */
  exitDate: string | null;
  buys: number;
  sells: number;
  volumeBuyUSD: number | null;
  volumeSellUSD: number | null;
  avgBuyPriceUSD: number | null;
  avgSellPriceUSD: number | null;
  realizedPnlUSD: number | null;
  unrealizedPnlUSD: number | null;
  totalPnlUSD: number | null;
  remainingBalance: number | null;
  feesUSD: number | null;
  swapCount: number | null;
}

export interface PositionHistoryEntry {
  token: UpstreamToken;
  cycle: PositionCycle;
}

/** One live position from `/2/wallet/positions`. */
export interface WalletPosition {
  token: UpstreamToken;
  balance: number | null;
  amountUSD: number | null;
  buys: number | null;
  sells: number | null;
  volumeBuy: number | null;
  volumeSell: number | null;
  realizedPnlUSD: number | null;
  unrealizedPnlUSD: number | null;
  totalPnlUSD: number | null;
  totalFeesPaidUSD: number | null;
  firstDate: string | null;
  lastDate: string | null;
  labels?: unknown[];
}

/**
 * One swap from `/2/wallet/trades`.
 *
 * The only place Mobula exposes the fee decomposition — gas, aggregator/platform
 * and the MEV component are separate fields. `blockchain` here is a display name
 * (`"Ethereum"`, `"Base"`), not a chain id.
 */
export interface WalletTrade {
  id?: string;
  type?: 'buy' | 'sell' | string;
  /** Unix milliseconds. */
  date: number | string | null;
  blockchain?: string;
  transactionHash?: string;
  baseToken?: UpstreamToken;
  quoteToken?: UpstreamToken;
  totalFeesUSD: number | null;
  gasFeesUSD: number | null;
  platformFeesUSD: number | null;
  mevFeesUSD: number | null;
}

/** `/2/wallet/funding` — the first inbound transfer that ever funded the wallet. */
export interface WalletFunding {
  from?: string;
  chainId?: string;
  /** ISO 8601. */
  date?: string;
  txHash?: string;
  amount?: string;
  fromWalletTag?: string | null;
  fromWalletMetadata?: {
    entityName?: string | null;
    entityType?: string | null;
    entityLabels?: string[];
  } | null;
}

/** One line item of Mobula's explainable security score. */
export interface SecurityCheck {
  id: number;
  name: string;
  kind: 'penalty' | 'bonus' | string;
  /** Points actually applied after caps and the CEX multiplier. */
  delta: number;
  rawDelta?: number;
  cap?: number;
  meta?: Record<string, unknown>;
}

/** `/2/token/security` — 0-100 score with a per-check breakdown. */
export interface TokenSecurity {
  address?: string;
  chainId?: string;
  securityScore: number | null;
  isHoneypot?: boolean | null;
  renounced?: boolean | null;
  securityScoreDetails?: {
    version?: number;
    base?: number;
    /** A hard kill zeroes the score outright, e.g. bundler supply over 40%. */
    killed?: boolean;
    killReason?: string | null;
    hardKill?: { id?: string; description?: string } | null;
    checks?: SecurityCheck[];
  } | null;
}

export interface LighthouseSlice {
  volumeUSD?: Record<string, number>;
  trades?: Record<string, number>;
  buys?: Record<string, number>;
  sells?: Record<string, number>;
  feesPaidUSD?: Record<string, number>;
}

/** `/2/market/lighthouse` — global market aggregate, the denominator for context. */
export interface Lighthouse {
  total?: LighthouseSlice;
  byChain?: unknown;
  byDex?: unknown;
  byLaunchpad?: unknown;
  byPlatform?: unknown;
}

export interface Envelope<T> {
  data: T;
}
