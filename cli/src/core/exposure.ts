/**
 * The exposure dossier.
 *
 * This is the argument the product makes: everything below is derived from public
 * data that anyone with a wallet address can already pull, from one vendor, with
 * no credentials. Nothing here is inferred beyond what the arithmetic supports,
 * and every section names the upstream endpoints it came from so a reader can go
 * and check.
 *
 * Pure. No clock, no network, no environment — the bundle's window is the only
 * notion of "now", exactly as in the derivation it sits beside.
 */

import { ENDPOINTS, OPTIONAL_ENDPOINTS, deriveMetrics, normalizeChain } from '@zegel/evidence';
import type { DerivedMetrics, SecurityReading } from '@zegel/evidence';
import type { ChainId, EvidenceBundle, EvidenceSource } from '@zegel/sdk/types';

/**
 * Contracts that show up as the swap sender on a trade.
 *
 * Only entries verifiable from the projects' own published deployment records are
 * listed; anything else is reported by address and called unrecognised, because a
 * guessed venue label in a surveillance dossier is worse than no label.
 */
const KNOWN_VENUES: Readonly<Record<string, string>> = {
  '0x7a250d5630b4cf539739df2c5dacb4c659f2488d': 'Uniswap V2 Router 02',
  '0xe592427a0aece92de3edee1f18e0157c05861564': 'Uniswap V3 SwapRouter',
  '0x68b3465833fb72a70ecdf485e0e4c7bd8665fc45': 'Uniswap V3 SwapRouter02',
  '0x3fc91a3afd70395cd496c647d5a6cc9d4b2b7fad': 'Uniswap Universal Router',
  '0x66a9893cc07d91d95644aedd05d03f95e1dba8af': 'Uniswap Universal Router v2',
  '0x2626664c2603336e57b271c5c0b26f421741e481': 'Uniswap V3 SwapRouter02 (Base)',
  '0x4752ba5dbc23f44d87826276bf6fd6b1c372ad24': 'Uniswap V2 Router 02 (Base)',
  '0x1111111254eeb25477b68fb85ed929f73a960582': '1inch Aggregation Router v5',
  '0x111111125421ca6dc452d289314280a0f8842a65': '1inch Aggregation Router v6',
  '0xdef1c0ded9bec7f1a1670819833240f027b25eff': '0x Exchange Proxy',
  '0x6131b5fae19ea4f9d964eac0408e4408b66337b5': 'KyberSwap Aggregation Router v2',
  '0x881d40237659c251811cec9c364ef91dc08d300c': 'MetaMask Swap Router',
  '0x00000000000001ad428e4906ae43d8f9852d0dd6': 'Permit2 / Uniswap X filler',
};

export interface VenueUse {
  address: string;
  label: string | null;
  chain: ChainId | null;
  trades: number;
  share: number;
}

export interface ClockFingerprint {
  /** Trades that carried a usable timestamp. */
  samples: number;
  /** 24 buckets, index = UTC hour. */
  histogram: readonly number[];
  /** The three busiest UTC hours, busiest first. */
  busiestHours: readonly number[];
  /** Start of the longest stretch with no activity at all, or the quietest 8h window. */
  quietStartUtc: number;
  quietHours: number;
  /** Offset implied by assuming the quiet stretch is a 00:00-08:00 local night. */
  impliedOffsetHours: number;
  /** How much of the day's activity falls in the busiest 8 hours. */
  concentration: number;
  confidence: 'weak' | 'moderate' | 'strong';
}

export interface FundingOrigin {
  from: string;
  chain: ChainId | null;
  dateIso: string;
  ageDays: number;
  txHash: string | null;
  tag: string | null;
  entityName: string | null;
  entityType: string | null;
  entityLabels: readonly string[];
}

export interface Holding {
  symbol: string;
  chain: ChainId | null;
  valueUsd: number;
  unrealizedPnlUsd: number;
  exchange: string | null;
}

export interface AssetResult {
  symbol: string;
  chain: ChainId | null;
  address: string;
  realizedPnlUsd: number;
  volumeUsd: number;
  cycles: number;
}

export interface UnavailableUpstream {
  endpoint: string;
  status: number | null;
  reason: string;
}

export interface ExposureReport {
  address: string;
  chains: readonly ChainId[];
  window: { from: string; to: string };
  metrics: DerivedMetrics;
  /** Best and worst completed trades, which is what a reader actually looks for. */
  bestAssets: readonly AssetResult[];
  worstAssets: readonly AssetResult[];
  venues: readonly VenueUse[];
  clock: ClockFingerprint | null;
  funding: FundingOrigin | null;
  labels: readonly string[];
  holdings: readonly Holding[];
  holdingsValueUsd: number;
  riskiest: readonly SecurityReading[];
  /** Addresses other than the subject that appear as a swap sender or recipient. */
  linkedAddresses: readonly string[];
  unavailable: readonly UnavailableUpstream[];
  /** Endpoint -> the source indices that backed each section, for `--explain`. */
  provenance: Readonly<Record<string, readonly number[]>>;
}

// ---------------------------------------------------------------------------

interface Body<T> {
  index: number;
  params: Readonly<Record<string, string | number | boolean>>;
  body: T;
}

function bodies<T>(bundle: EvidenceBundle, path: string): Body<T>[] {
  const endpoint = `GET ${path}`;
  const out: Body<T>[] = [];
  for (const source of bundle.sources) {
    if (source.endpoint !== endpoint) continue;
    if (source.unavailable !== undefined) continue;
    if (source.body === undefined || source.body === null) continue;
    out.push({ index: source.index, params: source.params, body: source.body as T });
  }
  return out.sort((a, b) => a.index - b.index);
}

function num(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : 0;
}

interface RawTrade {
  date?: number | string | null;
  swapSenderAddress?: string | null;
  swapRecipient?: string | null;
  transactionSenderAddress?: string | null;
  blockchain?: string | null;
}

interface RawPosition {
  token?: { symbol?: string; chainId?: string; exchange?: { name?: string } | null };
  amountUSD?: number | null;
  unrealizedPnlUSD?: number | null;
}

interface RawFunding {
  data?: {
    from?: string;
    chainId?: string;
    date?: string;
    txHash?: string;
    fromWalletTag?: string | null;
    fromWalletMetadata?: {
      entityName?: string | null;
      entityType?: string | null;
      entityLabels?: string[];
    } | null;
  };
}

/**
 * Infers a working-hours fingerprint from trade timestamps.
 *
 * The inference is one assumption, stated in the output rather than buried: the
 * longest daily stretch with no trades is a night. Everything else is arithmetic.
 * With few samples the answer is worthless and says so — `confidence` is derived
 * from sample count and from how concentrated the activity actually is, so a
 * wallet that trades round the clock does not get a confident timezone attached.
 */
export function inferClock(timestampsMs: readonly number[]): ClockFingerprint | null {
  const usable = timestampsMs.filter((t) => Number.isFinite(t) && t > 0);
  if (usable.length === 0) return null;

  const histogram = new Array<number>(24).fill(0);
  for (const t of usable) {
    const hour = new Date(t).getUTCHours();
    histogram[hour] = (histogram[hour] ?? 0) + 1;
  }

  // Quietest contiguous eight hours, wrapping past midnight.
  let quietStart = 0;
  let quietBest = Number.POSITIVE_INFINITY;
  for (let start = 0; start < 24; start++) {
    let total = 0;
    for (let k = 0; k < 8; k++) total += histogram[(start + k) % 24] ?? 0;
    if (total < quietBest) {
      quietBest = total;
      quietStart = start;
    }
  }

  // Busiest contiguous eight hours, for the concentration figure.
  let busyBest = 0;
  for (let start = 0; start < 24; start++) {
    let total = 0;
    for (let k = 0; k < 8; k++) total += histogram[(start + k) % 24] ?? 0;
    if (total > busyBest) busyBest = total;
  }

  const ranked = histogram
    .map((value, hour) => ({ value, hour }))
    .sort((a, b) => b.value - a.value || a.hour - b.hour)
    .filter((entry) => entry.value > 0)
    .slice(0, 3)
    .map((entry) => entry.hour);

  const concentration = busyBest / usable.length;
  // A local night of 00:00-08:00 puts the quiet window's start at local midnight.
  const rawOffset = ((0 - quietStart) % 24 + 24) % 24;
  const impliedOffsetHours = rawOffset > 12 ? rawOffset - 24 : rawOffset;

  const confidence: ClockFingerprint['confidence'] =
    usable.length >= 40 && concentration >= 0.7
      ? 'strong'
      : usable.length >= 15 && concentration >= 0.55
        ? 'moderate'
        : 'weak';

  return {
    samples: usable.length,
    histogram,
    busiestHours: ranked,
    quietStartUtc: quietStart,
    quietHours: 8,
    impliedOffsetHours,
    concentration,
    confidence,
  };
}

/** Everything the dossier renders, extracted from one evidence bundle. */
export function analyseExposure(bundle: EvidenceBundle): ExposureReport {
  const metrics = deriveMetrics(bundle);
  const provenance: Record<string, readonly number[]> = {};

  // --- assets, best and worst ---------------------------------------------
  const byAsset = new Map<string, AssetResult>();
  for (const cycle of metrics.closedCycles) {
    const key = `${cycle.chain ?? 'unknown'}|${cycle.address}`;
    const existing = byAsset.get(key);
    if (existing === undefined) {
      byAsset.set(key, {
        symbol: cycle.symbol,
        chain: cycle.chain,
        address: cycle.address,
        realizedPnlUsd: cycle.realizedPnlUsd,
        volumeUsd: cycle.volumeUsd,
        cycles: 1,
      });
    } else {
      existing.realizedPnlUsd += cycle.realizedPnlUsd;
      existing.volumeUsd += cycle.volumeUsd;
      existing.cycles += 1;
    }
  }
  const assets = [...byAsset.values()].sort(
    (a, b) => b.realizedPnlUsd - a.realizedPnlUsd || a.symbol.localeCompare(b.symbol),
  );
  provenance['assets'] = metrics.historySourceIndices;

  // --- venues and the clock ------------------------------------------------
  const tradeSources = bodies<{ data?: RawTrade[] }>(bundle, ENDPOINTS.trades);
  const timestamps: number[] = [];
  const venueCounts = new Map<string, { chain: ChainId | null; trades: number }>();
  const linked = new Set<string>();
  const subject = bundle.subject.address.toLowerCase();
  const tradeIndices: number[] = [];

  for (const source of tradeSources) {
    let used = false;
    for (const trade of source.body.data ?? []) {
      const at = typeof trade.date === 'number' ? trade.date : Date.parse(String(trade.date ?? ''));
      if (Number.isFinite(at)) {
        timestamps.push(at);
        used = true;
      }
      const chain = normalizeChain(trade.blockchain);
      const venue = (trade.swapSenderAddress ?? '').toLowerCase();
      if (venue !== '') {
        const entry = venueCounts.get(venue);
        if (entry === undefined) venueCounts.set(venue, { chain, trades: 1 });
        else entry.trades += 1;
        used = true;
      }
      for (const candidate of [trade.swapRecipient, trade.transactionSenderAddress]) {
        const other = (candidate ?? '').toLowerCase();
        if (other !== '' && other !== subject && other !== venue) linked.add(other);
      }
    }
    if (used) tradeIndices.push(source.index);
  }

  const totalVenueTrades = [...venueCounts.values()].reduce((sum, v) => sum + v.trades, 0);
  const venues: VenueUse[] = [...venueCounts.entries()]
    .map(([address, v]) => ({
      address,
      label: KNOWN_VENUES[address] ?? null,
      chain: v.chain,
      trades: v.trades,
      share: totalVenueTrades > 0 ? v.trades / totalVenueTrades : 0,
    }))
    .sort((a, b) => b.trades - a.trades || a.address.localeCompare(b.address));

  provenance['venues'] = tradeIndices;
  provenance['clock'] = tradeIndices;

  // --- first funding -------------------------------------------------------
  const fundingSources = bodies<RawFunding>(bundle, ENDPOINTS.funding);
  const windowEnd = Date.parse(bundle.window.to);
  let funding: FundingOrigin | null = null;
  for (const source of fundingSources) {
    const data = source.body.data;
    const dateIso = data?.date;
    const fundedMs = dateIso === undefined ? Number.NaN : Date.parse(dateIso);
    if (!Number.isFinite(fundedMs) || data?.from === undefined) continue;
    const candidate: FundingOrigin = {
      from: data.from,
      chain: normalizeChain(data.chainId),
      dateIso: dateIso as string,
      ageDays: (windowEnd - fundedMs) / 86_400_000,
      txHash: data.txHash ?? null,
      tag: data.fromWalletTag ?? null,
      entityName: data.fromWalletMetadata?.entityName ?? null,
      entityType: data.fromWalletMetadata?.entityType ?? null,
      entityLabels: data.fromWalletMetadata?.entityLabels ?? [],
    };
    if (funding === null || candidate.ageDays > funding.ageDays) funding = candidate;
  }
  provenance['funding'] =
    metrics.fundingSourceIndex === null ? [] : [metrics.fundingSourceIndex];

  // --- labels --------------------------------------------------------------
  const labelSources = bodies<{ data?: unknown[] }>(bundle, ENDPOINTS.labels);
  const labels = new Set<string>();
  for (const source of labelSources) {
    for (const entry of source.body.data ?? []) {
      if (typeof entry === 'string') labels.add(entry);
      else if (entry !== null && typeof entry === 'object') {
        const record = entry as { label?: unknown; name?: unknown; type?: unknown };
        const value = record.label ?? record.name ?? record.type;
        if (typeof value === 'string') labels.add(value);
      }
    }
  }
  provenance['labels'] = labelSources.map((s) => s.index);

  // --- current holdings ----------------------------------------------------
  const positionSources = bodies<{ data?: RawPosition[] }>(bundle, ENDPOINTS.positions);
  const holdings: Holding[] = [];
  for (const source of positionSources) {
    for (const position of source.body.data ?? []) {
      const valueUsd = num(position.amountUSD);
      if (valueUsd <= 0) continue;
      holdings.push({
        symbol: position.token?.symbol ?? 'unknown',
        chain: normalizeChain(position.token?.chainId),
        valueUsd,
        unrealizedPnlUsd: num(position.unrealizedPnlUSD),
        exchange: position.token?.exchange?.name ?? null,
      });
    }
  }
  holdings.sort((a, b) => b.valueUsd - a.valueUsd || a.symbol.localeCompare(b.symbol));
  provenance['holdings'] = positionSources.map((s) => s.index);

  provenance['risk'] = metrics.security.sourceIndices;
  provenance['fees'] = metrics.mev.sourceIndices;

  const riskiest = [...metrics.security.readings].sort(
    (a, b) => a.score - b.score || a.symbol.localeCompare(b.symbol),
  );

  return {
    address: bundle.subject.address,
    chains: bundle.subject.chains,
    window: { from: bundle.window.from, to: bundle.window.to },
    metrics,
    bestAssets: assets.filter((a) => a.realizedPnlUsd > 0).slice(0, 5),
    worstAssets: assets
      .filter((a) => a.realizedPnlUsd < 0)
      .sort((a, b) => a.realizedPnlUsd - b.realizedPnlUsd)
      .slice(0, 5),
    venues,
    clock: inferClock(timestamps),
    funding,
    labels: [...labels].sort(),
    holdings: holdings.slice(0, 8),
    holdingsValueUsd: holdings.reduce((sum, h) => sum + h.valueUsd, 0),
    riskiest,
    linkedAddresses: [...linked].sort(),
    unavailable: bundle.sources
      .filter((s): s is EvidenceSource & { unavailable: { reason: string; status?: number } } =>
        s.unavailable !== undefined,
      )
      .map((s) => ({
        endpoint: s.endpoint,
        status: s.unavailable.status ?? null,
        reason: s.unavailable.reason,
      })),
    provenance,
  };
}

/** Endpoints that are known to fail upstream, so a reader can tell flaky from broken. */
export const KNOWN_FLAKY_ENDPOINTS: readonly string[] = Object.values(OPTIONAL_ENDPOINTS).map(
  (path) => `GET ${path}`,
);
