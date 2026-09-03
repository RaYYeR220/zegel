/**
 * `@zegel/evidence` — the evidence engine.
 *
 * Collects verbatim Mobula responses about a wallet, derives a fixed set of
 * plain-English claims from them, and hands both to the sealing layer. The
 * derivation is pure and its rules are hashed into `DERIVATION_ID`, so a grantee
 * re-runs it against the same raw bodies instead of taking our word for it.
 */

export {
  createMobulaClient,
  MobulaError,
  isRetryableStatus,
  backoffDelay,
  DEFAULT_RETRY,
  DEMO_BASE_URL,
  PROD_BASE_URL,
  GRAPHQL_URL,
} from './client.js';
export type {
  MobulaClient,
  MobulaClientOptions,
  MobulaOk,
  MobulaAttempt,
  RetryPolicy,
  QueryParams,
} from './client.js';

export { createRateLimitObserver, snapshotFromHeaders } from './ratelimit.js';
export type { RateLimitObserver, RateLimitSnapshot, RateLimitListener } from './ratelimit.js';

export { CANONICAL_CHAINS, normalizeChain, toQueryChain, compareChains } from './chains.js';

export { ENDPOINTS, OPTIONAL_ENDPOINTS, KNOWN_FLAKY, CREDIT_COST } from './endpoints.js';

export {
  buildEvidence,
  estimateCredits,
  controlProofMessage,
  isControlProven,
  randomReferenceId,
} from './collect.js';
export type { BuildEvidenceOptions, CollectProgress } from './collect.js';

export {
  deriveClaims,
  deriveMetrics,
  unavailableSources,
  CLAIM_SPECS,
  DERIVATION,
  DERIVATION_ID,
  DERIVATION_PARAMS,
  DERIVATION_VERSION,
} from './derive.js';
export type { DerivedMetrics, NormalizedCycle, SecurityReading } from './derive.js';

export { toClaimSet, commitmentFor } from './claimset.js';
export { verifyClaims } from './verify.js';
export type { VerifyResult } from './verify.js';

export {
  openPositionsStream,
  streamCapability,
  DEFAULT_POLL_INTERVAL_MS,
  WS_URL,
} from './streams.js';
export type {
  StreamCapability,
  StreamMode,
  StreamSession,
  PositionsStreamOptions,
} from './streams.js';

export { filterTokens, tokenTopTraders, toNetworkId, SOLANA_NETWORK_ID } from './graphql.js';
export type { FilterTokensRow, TopTraderRow, TopTradersQuery, TradingPeriod } from './graphql.js';

export type {
  Envelope,
  Lighthouse,
  Paginated,
  PositionCycle,
  PositionHistoryEntry,
  SecurityCheck,
  TokenSecurity,
  UpstreamToken,
  WalletFunding,
  WalletPosition,
  WalletTrade,
} from './upstream.js';
