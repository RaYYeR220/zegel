import { canonicalDigest } from './sdk.js';
import type { ChainId, Claim, EvidenceBundle, EvidenceSource } from './sdk.js';
import { normalizeChain } from './chains.js';
import { ENDPOINTS } from './endpoints.js';
import type {
  Envelope,
  Paginated,
  PositionHistoryEntry,
  TokenSecurity,
  WalletFunding,
  WalletTrade,
} from './upstream.js';

/**
 * The derivation.
 *
 * Two properties matter more than anything else here:
 *
 *   1. It is pure. Nothing is read from the clock, the network or the
 *      environment; `bundle.window.to` is the only notion of "now". The same
 *      bundle produces byte-identical claims on any machine, which is what lets
 *      a grantee re-run it instead of trusting us.
 *   2. It never guesses. A metric whose source is missing or unusable yields no
 *      claim at all, rather than a claim computed from a default. A reference
 *      with eight claims and an honest gap is worth more than one with ten
 *      claims and an invented number.
 */

export const DERIVATION_VERSION = 'zegel.derivation.v1';

/**
 * Fixed thresholds, deliberately not per-caller.
 *
 * Every reference is scored by the same bar, so two references are directly
 * comparable — and `DERIVATION_ID` proves they were. A caller-tunable threshold
 * would let an issuer shop for a bar their subject happens to clear.
 */
export const DERIVATION_PARAMS = {
  /** Mobula `securityScore` at or above this is treated as a normal-risk asset. */
  securityScoreFloor: 60,
  /** Share of scored assets allowed below the floor. */
  maxRiskyAssetShare: 0.2,
  minRealizedPnlUsd: 0,
  minClosedCycles: 10,
  minWinRate: 0.4,
  maxDrawdownUsd: 25_000,
  minMedianHoldingDays: 1,
  maxTradingCostRatio: 0.02,
  maxMevFeeShare: 0.25,
  maxTopAssetShare: 0.5,
  minWalletAgeDays: 180,
} as const;

const MS_PER_DAY = 86_400_000;

export interface NormalizedCycle {
  chain: ChainId | null;
  address: string;
  symbol: string;
  entryMs: number | null;
  exitMs: number | null;
  realizedPnlUsd: number;
  feesUsd: number;
  volumeUsd: number;
  sourceIndex: number;
}

export interface SecurityReading {
  chain: ChainId | null;
  address: string;
  symbol: string;
  score: number;
  killed: boolean;
  killReason: string | null;
  sourceIndex: number;
}

export interface DerivedMetrics {
  closedCycles: readonly NormalizedCycle[];
  realizedPnlUsd: number;
  winRate: number | null;
  maxDrawdownUsd: number | null;
  medianHoldingDays: number | null;
  grossVolumeUsd: number;
  totalFeesUsd: number;
  tradingCostRatio: number | null;
  mev: {
    sampledTrades: number;
    totalFeesUsd: number;
    mevFeesUsd: number;
    share: number | null;
    sourceIndices: readonly number[];
  };
  security: {
    tradedAssets: number;
    scored: number;
    unscored: number;
    risky: number;
    riskyShare: number | null;
    readings: readonly SecurityReading[];
    sourceIndices: readonly number[];
  };
  concentration: {
    topAssetShare: number | null;
    topAssetSymbol: string | null;
  };
  walletAgeDays: number | null;
  fundingSourceIndex: number | null;
  historySourceIndices: readonly number[];
}

// ---------------------------------------------------------------------------
// source access
// ---------------------------------------------------------------------------

interface UsableSource<T> {
  index: number;
  params: Readonly<Record<string, string | number | boolean>>;
  body: T;
}

/** Only sources that actually carry a body can back a claim. */
function usable<T>(bundle: EvidenceBundle, path: string): UsableSource<T>[] {
  const endpoint = `GET ${path}`;
  const out: UsableSource<T>[] = [];
  for (const source of bundle.sources) {
    if (source.endpoint !== endpoint) continue;
    if (source.unavailable !== undefined) continue;
    if (source.body === undefined || source.body === null) continue;
    out.push({ index: source.index, params: source.params, body: source.body as T });
  }
  return out.sort((a, b) => a.index - b.index);
}

function toMs(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const ms = typeof value === 'number' ? value : Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function num(value: number | string | null | undefined): number {
  if (value === null || value === undefined) return 0;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : 0;
}

function round(value: number, dp: number): number {
  const factor = 10 ** dp;
  // `+0` keeps `-0` out of the canonical encoding, where it would hash differently.
  return Math.round(value * factor) / factor + 0;
}

function assetKey(chain: ChainId | null, address: string): string {
  return `${chain ?? 'unknown'}|${address.toLowerCase()}`;
}

// ---------------------------------------------------------------------------
// metrics
// ---------------------------------------------------------------------------

/**
 * Every number the claims are built from, exposed separately so the app can show
 * the working. `deriveClaims` is a thin thresholding pass over this.
 */
export function deriveMetrics(bundle: EvidenceBundle): DerivedMetrics {
  const fromMs = Date.parse(bundle.window.from);
  const toMs_ = Date.parse(bundle.window.to);

  // --- closed trade cycles -------------------------------------------------
  const historySources = usable<Paginated<PositionHistoryEntry>>(
    bundle,
    ENDPOINTS.positionsHistory,
  );
  const seen = new Set<string>();
  const closedCycles: NormalizedCycle[] = [];

  for (const source of historySources) {
    for (const entry of source.body.data ?? []) {
      const cycle = entry.cycle;
      if (cycle === undefined || cycle === null || cycle.isOpen) continue;
      const exitMs = toMs(cycle.exitDate);
      if (exitMs === null || exitMs < fromMs || exitMs > toMs_) continue;

      const chain = normalizeChain(entry.token?.chainId);
      const address = (entry.token?.address ?? '').toLowerCase();
      const entryMs = toMs(cycle.entryDate);
      // Two per-chain requests can overlap when a filter is ignored upstream;
      // a cycle is identified by asset plus its exact entry and exit instants.
      const key = `${assetKey(chain, address)}|${entryMs ?? 'x'}|${exitMs}`;
      if (seen.has(key)) continue;
      seen.add(key);

      closedCycles.push({
        chain,
        address,
        symbol: entry.token?.symbol ?? address,
        entryMs,
        exitMs,
        realizedPnlUsd: num(cycle.realizedPnlUSD),
        feesUsd: num(cycle.feesUSD),
        volumeUsd: num(cycle.volumeBuyUSD) + num(cycle.volumeSellUSD),
        sourceIndex: source.index,
      });
    }
  }

  // Deterministic ordering: the drawdown walk and every floating-point sum
  // depend on it, so it must not follow request scheduling.
  closedCycles.sort(
    (a, b) =>
      (a.exitMs ?? 0) - (b.exitMs ?? 0) ||
      (a.entryMs ?? 0) - (b.entryMs ?? 0) ||
      assetKey(a.chain, a.address).localeCompare(assetKey(b.chain, b.address)),
  );

  let realizedPnlUsd = 0;
  let grossVolumeUsd = 0;
  let totalFeesUsd = 0;
  let wins = 0;
  let cumulative = 0;
  let peak = 0;
  let maxDrawdown = 0;
  const holdingDays: number[] = [];
  const volumeByAsset = new Map<string, { volume: number; symbol: string }>();

  for (const cycle of closedCycles) {
    realizedPnlUsd += cycle.realizedPnlUsd;
    grossVolumeUsd += cycle.volumeUsd;
    totalFeesUsd += cycle.feesUsd;
    if (cycle.realizedPnlUsd > 0) wins += 1;

    cumulative += cycle.realizedPnlUsd;
    if (cumulative > peak) peak = cumulative;
    const drawdown = peak - cumulative;
    if (drawdown > maxDrawdown) maxDrawdown = drawdown;

    if (cycle.entryMs !== null && cycle.exitMs !== null && cycle.exitMs >= cycle.entryMs) {
      holdingDays.push((cycle.exitMs - cycle.entryMs) / MS_PER_DAY);
    }

    const key = assetKey(cycle.chain, cycle.address);
    const bucket = volumeByAsset.get(key);
    if (bucket === undefined) volumeByAsset.set(key, { volume: cycle.volumeUsd, symbol: cycle.symbol });
    else bucket.volume += cycle.volumeUsd;
  }

  const count = closedCycles.length;

  // --- fee decomposition ---------------------------------------------------
  const tradeSources = usable<Paginated<WalletTrade>>(bundle, ENDPOINTS.trades);
  let sampledTrades = 0;
  let sampledFeesUsd = 0;
  let sampledMevUsd = 0;
  const tradeIndices: number[] = [];
  for (const source of tradeSources) {
    let used = false;
    for (const trade of source.body.data ?? []) {
      const at = toMs(trade.date);
      if (at === null || at < fromMs || at > toMs_) continue;
      sampledTrades += 1;
      sampledFeesUsd += num(trade.totalFeesUSD);
      sampledMevUsd += num(trade.mevFeesUSD);
      used = true;
    }
    if (used) tradeIndices.push(source.index);
  }

  // --- risk quality --------------------------------------------------------
  const securitySources = usable<Envelope<TokenSecurity>>(bundle, ENDPOINTS.tokenSecurity);
  const securityByAsset = new Map<string, UsableSource<Envelope<TokenSecurity>>>();
  for (const source of securitySources) {
    const chain = normalizeChain(
      source.body.data?.chainId ?? (source.params['chainId'] as string | undefined),
    );
    const address = String(source.body.data?.address ?? source.params['address'] ?? '').toLowerCase();
    if (address === '') continue;
    securityByAsset.set(assetKey(chain, address), source);
  }

  const tradedAssets = [...volumeByAsset.keys()].sort();
  const readings: SecurityReading[] = [];
  const securityIndices: number[] = [];
  let risky = 0;

  for (const key of tradedAssets) {
    const source = securityByAsset.get(key);
    if (source === undefined) continue;
    const data = source.body.data;
    const score = data?.securityScore;
    if (typeof score !== 'number' || !Number.isFinite(score)) continue;

    const killed = data?.securityScoreDetails?.killed === true;
    const parts = key.split('|');
    readings.push({
      chain: (parts[0] === 'unknown' ? null : parts[0]) as ChainId | null,
      address: parts[1] ?? '',
      symbol: volumeByAsset.get(key)?.symbol ?? (parts[1] ?? ''),
      score,
      killed,
      killReason: data?.securityScoreDetails?.killReason ?? null,
      sourceIndex: source.index,
    });
    securityIndices.push(source.index);
    if (killed || score < DERIVATION_PARAMS.securityScoreFloor) risky += 1;
  }
  securityIndices.sort((a, b) => a - b);

  // --- concentration -------------------------------------------------------
  let topAssetShare: number | null = null;
  let topAssetSymbol: string | null = null;
  if (grossVolumeUsd > 0) {
    let best = { volume: -1, symbol: '' };
    for (const key of tradedAssets) {
      const bucket = volumeByAsset.get(key);
      if (bucket === undefined) continue;
      if (bucket.volume > best.volume) best = { volume: bucket.volume, symbol: bucket.symbol };
    }
    topAssetShare = round(best.volume / grossVolumeUsd, 6);
    topAssetSymbol = best.symbol;
  }

  // --- wallet age ----------------------------------------------------------
  const fundingSources = usable<Envelope<WalletFunding>>(bundle, ENDPOINTS.funding);
  let walletAgeDays: number | null = null;
  let fundingSourceIndex: number | null = null;
  for (const source of fundingSources) {
    const fundedMs = toMs(source.body.data?.date);
    if (fundedMs === null) continue;
    const age = (toMs_ - fundedMs) / MS_PER_DAY;
    // Several chains may each report a first funding; the wallet is as old as
    // the earliest of them.
    if (walletAgeDays === null || age > walletAgeDays) {
      walletAgeDays = age;
      fundingSourceIndex = source.index;
    }
  }

  return {
    closedCycles,
    realizedPnlUsd: round(realizedPnlUsd, 2),
    winRate: count === 0 ? null : round(wins / count, 6),
    maxDrawdownUsd: count === 0 ? null : round(maxDrawdown, 2),
    medianHoldingDays: holdingDays.length === 0 ? null : round(median(holdingDays), 4),
    grossVolumeUsd: round(grossVolumeUsd, 2),
    totalFeesUsd: round(totalFeesUsd, 2),
    tradingCostRatio: grossVolumeUsd > 0 ? round(totalFeesUsd / grossVolumeUsd, 6) : null,
    mev: {
      sampledTrades,
      totalFeesUsd: round(sampledFeesUsd, 2),
      mevFeesUsd: round(sampledMevUsd, 2),
      share: sampledFeesUsd > 0 ? round(sampledMevUsd / sampledFeesUsd, 6) : null,
      sourceIndices: tradeIndices,
    },
    security: {
      tradedAssets: tradedAssets.length,
      scored: readings.length,
      unscored: tradedAssets.length - readings.length,
      risky,
      riskyShare: readings.length === 0 ? null : round(risky / readings.length, 6),
      readings,
      sourceIndices: securityIndices,
    },
    concentration: { topAssetShare, topAssetSymbol },
    walletAgeDays: walletAgeDays === null ? null : round(walletAgeDays, 2),
    fundingSourceIndex,
    historySourceIndices: historySources.map((s) => s.index),
  };
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  if (sorted.length % 2 === 1) return sorted[mid] ?? 0;
  return ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
}

// ---------------------------------------------------------------------------
// claims
// ---------------------------------------------------------------------------

const P = DERIVATION_PARAMS;
const pct = (ratio: number): string => `${round(ratio * 100, 0)}%`;

/**
 * Statements assert the threshold, never the measured value.
 *
 * A tier-1 grantee reads these without `actual`, so a statement that quoted the
 * real number would defeat the whole point of the tier split. `passed` says
 * whether the assertion holds; the sentence says what was asserted.
 */
interface ClaimSpec {
  id: string;
  statement: string;
  op: Claim['op'];
  threshold: number | readonly [number, number];
  unit: Claim['unit'];
  /** Human description of the rule, hashed into `DERIVATION_ID`. */
  rule: string;
  inputs: readonly string[];
}

export const CLAIM_SPECS: readonly ClaimSpec[] = [
  {
    id: 'realized-pnl-usd',
    statement: 'Completed trades over this period ended in net profit rather than a net loss.',
    op: 'gte',
    threshold: P.minRealizedPnlUsd,
    unit: 'usd',
    rule: 'sum of cycle.realizedPnlUSD over closed cycles whose exitDate falls inside the window',
    inputs: [`${ENDPOINTS.positionsHistory}#data[].cycle.realizedPnlUSD`],
  },
  {
    id: 'closed-position-cycles',
    statement: `This wallet completed at least ${P.minClosedCycles} full buy-and-sell trades in this period, so the record is more than a couple of lucky bets.`,
    op: 'gte',
    threshold: P.minClosedCycles,
    unit: 'count',
    rule: 'count of closed cycles whose exitDate falls inside the window',
    inputs: [`${ENDPOINTS.positionsHistory}#data[].cycle.isOpen`],
  },
  {
    id: 'win-rate',
    statement: `At least ${pct(P.minWinRate)} of its completed trades made money.`,
    op: 'gte',
    threshold: P.minWinRate,
    unit: 'ratio',
    rule: 'closed cycles with realizedPnlUSD > 0, divided by all closed cycles in the window',
    inputs: [`${ENDPOINTS.positionsHistory}#data[].cycle.realizedPnlUSD`],
  },
  {
    id: 'max-drawdown-usd',
    statement: `Its running profit never fell more than $${P.maxDrawdownUsd.toLocaleString('en-US')} below its own best point, so no single run of losses erased the record.`,
    op: 'lte',
    threshold: P.maxDrawdownUsd,
    unit: 'usd',
    rule: 'largest peak-to-trough fall of the cumulative realized PnL curve, cycles ordered by exit time',
    inputs: [`${ENDPOINTS.positionsHistory}#data[].cycle.realizedPnlUSD`],
  },
  {
    id: 'median-holding-period-days',
    statement: `A typical trade was held for at least ${P.minMedianHoldingDays} day, rather than flipped within minutes the way an automated bot trades.`,
    op: 'gte',
    threshold: P.minMedianHoldingDays,
    unit: 'days',
    rule: 'median of (exitDate - entryDate) in days over closed cycles in the window',
    inputs: [`${ENDPOINTS.positionsHistory}#data[].cycle.entryDate|exitDate`],
  },
  {
    id: 'trading-cost-ratio',
    statement: `Trading costs — network fees, exchange fees and value lost to bots trading ahead of its orders — stayed under ${pct(P.maxTradingCostRatio)} of the amount traded.`,
    op: 'lte',
    threshold: P.maxTradingCostRatio,
    unit: 'ratio',
    rule: 'sum of cycle.feesUSD divided by sum of (volumeBuyUSD + volumeSellUSD) over closed cycles in the window',
    inputs: [
      `${ENDPOINTS.positionsHistory}#data[].cycle.feesUSD`,
      `${ENDPOINTS.positionsHistory}#data[].cycle.volumeBuyUSD|volumeSellUSD`,
    ],
  },
  {
    id: 'mev-fee-share',
    statement: `Less than ${pct(P.maxMevFeeShare)} of what it paid in trading costs was taken by bots front-running its orders.`,
    op: 'lte',
    threshold: P.maxMevFeeShare,
    unit: 'ratio',
    rule: 'sum of mevFeesUSD divided by sum of totalFeesUSD over the sampled swaps inside the window',
    inputs: [`${ENDPOINTS.trades}#data[].mevFeesUSD|totalFeesUSD`],
  },
  {
    id: 'risk-quality-ratio',
    statement: `Fewer than 1 in ${Math.round(1 / P.maxRiskyAssetShare)} of the tokens it traded score below ${P.securityScoreFloor} out of 100 on Mobula's 14-point safety check, which looks for the hallmarks of a scam token: hidden minting rights, insider bundling, faked trading volume and sell taxes that trap buyers.`,
    op: 'lte',
    threshold: P.maxRiskyAssetShare,
    unit: 'ratio',
    rule: `traded assets whose securityScore is below ${P.securityScoreFloor}, or whose score was hard-killed outright, divided by the traded assets that carry a score`,
    inputs: [
      `${ENDPOINTS.tokenSecurity}#data.securityScore`,
      `${ENDPOINTS.tokenSecurity}#data.securityScoreDetails.killed`,
    ],
  },
  {
    id: 'position-concentration',
    statement: `No single token accounted for more than ${pct(P.maxTopAssetShare)} of everything it traded, so the record is not one coin's story.`,
    op: 'lte',
    threshold: P.maxTopAssetShare,
    unit: 'ratio',
    rule: 'largest single-asset share of gross traded volume across closed cycles in the window',
    inputs: [`${ENDPOINTS.positionsHistory}#data[].cycle.volumeBuyUSD|volumeSellUSD`],
  },
  {
    id: 'wallet-age-days',
    statement: `The wallet has been in use for at least ${P.minWalletAgeDays} days, counted from the first time anyone sent money to it.`,
    op: 'gte',
    threshold: P.minWalletAgeDays,
    unit: 'days',
    rule: 'days between the earliest reported first-funding date and the end of the window',
    inputs: [`${ENDPOINTS.funding}#data.date`],
  },
];

/**
 * What `DERIVATION_ID` hashes.
 *
 * A digest of the compiled module file would have been the obvious choice, but
 * it is not stable across platforms — line endings, bundlers and minifiers all
 * change the bytes without changing the rules. Hashing the rules themselves —
 * every claim id, operator, threshold, formula and the upstream fields it reads,
 * plus the ordering and rounding conventions — gives the property that actually
 * matters: two bundles with the same `derivationId` were scored identically. A
 * test asserts the descriptor and the implementation cannot drift apart.
 */
export const DERIVATION = {
  version: DERIVATION_VERSION,
  params: DERIVATION_PARAMS,
  claims: CLAIM_SPECS.map((spec) => ({
    id: spec.id,
    op: spec.op,
    threshold: spec.threshold,
    unit: spec.unit,
    rule: spec.rule,
    inputs: spec.inputs,
    statement: spec.statement,
  })),
  conventions: {
    windowBounds: 'closed interval on cycle exit time, both endpoints inclusive',
    cycleOrdering: 'exit time, then entry time, then chain|address',
    cycleIdentity: 'chain|address|entry|exit — duplicates across per-chain requests are dropped',
    chainNormalization: 'evm:<decimal> or solana; unrecognised identifiers become null',
    rounding: { usd: 2, ratio: 6, days: 4, count: 0 },
    missingSource: 'the claim is omitted entirely; no default is substituted',
  },
} as const;

/** Digest of the derivation rules and their parameters. */
export const DERIVATION_ID: string = canonicalDigest(DERIVATION);

function specById(id: string): ClaimSpec {
  const spec = CLAIM_SPECS.find((s) => s.id === id);
  if (spec === undefined) throw new Error(`unknown claim spec: ${id}`);
  return spec;
}

function evaluate(op: Claim['op'], actual: number, threshold: ClaimSpec['threshold']): boolean {
  if (op === 'between') {
    if (!Array.isArray(threshold)) return false;
    const [lo, hi] = threshold as readonly [number, number];
    return actual >= lo && actual <= hi;
  }
  const bar = threshold as number;
  if (op === 'gte') return actual >= bar;
  if (op === 'lte') return actual <= bar;
  return actual === bar;
}

function claim(id: string, actual: number, sources: readonly number[]): Claim {
  const spec = specById(id);
  return {
    id: spec.id,
    statement: spec.statement,
    op: spec.op,
    threshold: spec.threshold,
    unit: spec.unit,
    passed: evaluate(spec.op, actual, spec.threshold),
    actual,
    sources: [...new Set(sources)].sort((a, b) => a - b),
  };
}

/**
 * Pure. Same bundle in, byte-identical claims out.
 *
 * Claims appear in `CLAIM_SPECS` order, and a claim whose inputs were not
 * available is simply absent — the caller can tell the difference between
 * "failed" and "could not be computed".
 */
export function deriveClaims(bundle: EvidenceBundle): Claim[] {
  const m = deriveMetrics(bundle);
  const history = m.historySourceIndices;
  const claims: Claim[] = [];

  if (history.length > 0) {
    claims.push(claim('realized-pnl-usd', m.realizedPnlUsd, history));
    claims.push(claim('closed-position-cycles', m.closedCycles.length, history));
  }
  if (m.winRate !== null) claims.push(claim('win-rate', m.winRate, history));
  if (m.maxDrawdownUsd !== null) claims.push(claim('max-drawdown-usd', m.maxDrawdownUsd, history));
  if (m.medianHoldingDays !== null) {
    claims.push(claim('median-holding-period-days', m.medianHoldingDays, history));
  }
  if (m.tradingCostRatio !== null) {
    claims.push(claim('trading-cost-ratio', m.tradingCostRatio, history));
  }
  if (m.mev.share !== null) claims.push(claim('mev-fee-share', m.mev.share, m.mev.sourceIndices));
  if (m.security.riskyShare !== null) {
    claims.push(claim('risk-quality-ratio', m.security.riskyShare, m.security.sourceIndices));
  }
  if (m.concentration.topAssetShare !== null) {
    claims.push(claim('position-concentration', m.concentration.topAssetShare, history));
  }
  if (m.walletAgeDays !== null && m.fundingSourceIndex !== null) {
    claims.push(claim('wallet-age-days', m.walletAgeDays, [m.fundingSourceIndex]));
  }

  const order = new Map(CLAIM_SPECS.map((spec, i) => [spec.id, i]));
  return claims.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
}

/** Endpoints a bundle could not collect, for the "what we could not prove" panel. */
export function unavailableSources(bundle: EvidenceBundle): readonly EvidenceSource[] {
  return bundle.sources.filter((s) => s.unavailable !== undefined);
}
