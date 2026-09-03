/** Mobula REST paths used by the evidence engine, and why each one is here. */
export const ENDPOINTS = {
  /** Closed trade cycles with their own realized PnL, entry and exit dates. The track record. */
  positionsHistory: '/2/wallet/positions-history',
  /** Current holdings with realized/unrealized PnL. Gives concentration and open exposure. */
  positions: '/2/wallet/positions',
  /** Per-swap fee decomposition: gas, platform, and the MEV component. */
  trades: '/2/wallet/trades',
  /** Mobula's wallet label taxonomy: proTrader, sniper, insider, bundler. */
  labels: '/2/wallet/labels',
  /** First inbound transfer that ever funded the wallet. Fixes wallet age. */
  funding: '/2/wallet/funding',
  /** 0-100 score over 14 named checks. Turns "what did you trade" into "what risk did you take". */
  tokenSecurity: '/2/token/security',
  /** Global market aggregate, so a number can be read against the market it happened in. */
  lighthouse: '/2/market/lighthouse',
} as const;

/**
 * Routes that returned real 500s on the demo host and are attempted but never
 * relied on. They are still recorded in the bundle as `unavailable` sources: a
 * reader should be able to see what we tried and failed to get, not just what we
 * got. Nothing derived depends on them.
 */
export const OPTIONAL_ENDPOINTS = {
  analysis: '/2/wallet/analysis',
  defiPositions: '/2/wallet/defi-positions',
  legacyHistory: '/1/wallet/history',
} as const;

export const KNOWN_FLAKY: readonly string[] = Object.values(OPTIONAL_ENDPOINTS);

/** Credit cost per call, from Mobula's published pricing. Drives the budget estimate. */
export const CREDIT_COST: Readonly<Record<string, number>> = {
  [ENDPOINTS.positionsHistory]: 1,
  [ENDPOINTS.positions]: 1,
  [ENDPOINTS.trades]: 1,
  [ENDPOINTS.labels]: 1,
  [ENDPOINTS.funding]: 1,
  [ENDPOINTS.tokenSecurity]: 10,
  [ENDPOINTS.lighthouse]: 1,
  [OPTIONAL_ENDPOINTS.analysis]: 5,
  [OPTIONAL_ENDPOINTS.defiPositions]: 10,
  [OPTIONAL_ENDPOINTS.legacyHistory]: 1,
};
