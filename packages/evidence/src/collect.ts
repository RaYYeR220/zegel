import { canonicalDigest } from './sdk.js';
import {
  BUNDLE_SCHEMA,
  type ChainId,
  type ControlProof,
  type EvidenceBundle,
  type EvidenceSource,
  type TimeWindow,
} from './sdk.js';
import { CANONICAL_CHAINS, normalizeChain, toQueryChain } from './chains.js';
import { createMobulaClient, type MobulaClient, type QueryParams } from './client.js';
import { CREDIT_COST, ENDPOINTS, OPTIONAL_ENDPOINTS } from './endpoints.js';
import { DERIVATION_ID, deriveClaims } from './derive.js';
import type { Paginated, PositionHistoryEntry } from './upstream.js';

const MS_PER_DAY = 86_400_000;
const DEFAULT_WINDOW_DAYS = 90;

export interface BuildEvidenceOptions {
  /** Reuse a client to share its rate-limit meter with the rest of the app. */
  client?: MobulaClient | undefined;
  chains?: readonly ChainId[] | undefined;
  /** Explicit window; otherwise the last `windowDays` ending at `now`. */
  window?: TimeWindow | undefined;
  windowDays?: number | undefined;
  now?: Date | undefined;
  /** 32-byte hex. Random by default — deriving it from the address would let an observer confirm a guess. */
  referenceId?: string | undefined;
  /** Supplied by the wallet layer. Absent means "control not yet proven", never a fake signature. */
  controlProof?: ControlProof | undefined;
  /** Page size for the per-chain wallet pulls. */
  historyLimit?: number | undefined;
  positionsLimit?: number | undefined;
  tradesLimit?: number | undefined;
  /** `/2/token/security` costs 10 credits a call, so the busiest assets come first. */
  maxSecurityLookups?: number | undefined;
  /** Attempt the routes known to 500, so the bundle records what could not be collected. */
  probeOptionalEndpoints?: boolean | undefined;
  concurrency?: number | undefined;
  onProgress?: ((event: CollectProgress) => void) | undefined;
}

export interface CollectProgress {
  endpoint: string;
  params: Readonly<Record<string, string | number | boolean>>;
  status: 'ok' | 'unavailable';
  httpStatus: number | null;
  /** Completed requests so far, out of the plan for this phase. */
  done: number;
  total: number;
}

interface PlannedRequest {
  path: string;
  params: QueryParams;
  /** Optional requests are recorded as unavailable on failure instead of throwing. */
  required: boolean;
}

/** Credits a collection will cost before it runs, for the budget meter. */
export function estimateCredits(options: BuildEvidenceOptions = {}): number {
  const chains = options.chains ?? CANONICAL_CHAINS;
  const perChain = CREDIT_COST[ENDPOINTS.positionsHistory]! +
    CREDIT_COST[ENDPOINTS.positions]! +
    CREDIT_COST[ENDPOINTS.trades]!;
  const optional =
    options.probeOptionalEndpoints === false
      ? 0
      : Object.values(OPTIONAL_ENDPOINTS).reduce((sum, path) => sum + (CREDIT_COST[path] ?? 1), 0);
  return (
    chains.length * perChain +
    CREDIT_COST[ENDPOINTS.labels]! +
    CREDIT_COST[ENDPOINTS.funding]! +
    CREDIT_COST[ENDPOINTS.lighthouse]! +
    (options.maxSecurityLookups ?? 25) * CREDIT_COST[ENDPOINTS.tokenSecurity]! +
    optional
  );
}

/** The exact string the subject wallet signs to prove control of the address. */
export function controlProofMessage(referenceId: string): string {
  return `Zegel reference ${referenceId}`;
}

/** A control proof with an empty signature has not been provided, and is never treated as valid. */
export function isControlProven(bundle: EvidenceBundle): boolean {
  return bundle.controlProof.signature !== '' && bundle.controlProof.signer !== '';
}

export function randomReferenceId(): string {
  const bytes = new Uint8Array(32);
  globalThis.crypto.getRandomValues(bytes);
  return `0x${[...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
}

/**
 * Collect the evidence a reference is made of.
 *
 * Every upstream response is kept exactly as it arrived, with its digest, its
 * parameters and the time it was fetched, because the grantee re-derives from
 * these bodies rather than trusting the claims. Anything that fails is recorded
 * as an unavailable source with its HTTP status — visible, and backing nothing.
 */
export async function buildEvidence(
  address: string,
  options: BuildEvidenceOptions = {},
): Promise<EvidenceBundle> {
  const client = options.client ?? createMobulaClient();
  const chains = [...(options.chains ?? CANONICAL_CHAINS)].sort();
  const window = resolveWindow(options);
  const referenceId = options.referenceId ?? randomReferenceId();
  // The demo host answers 429 well below a keyed plan's rate, so collection is
  // deliberately slow rather than partial.
  const concurrency = Math.max(1, options.concurrency ?? 2);

  const walletParams = { wallet: address };
  const plan: PlannedRequest[] = [];

  for (const chain of chains) {
    const chainIds = toQueryChain(chain);
    plan.push({
      path: ENDPOINTS.positionsHistory,
      params: { ...walletParams, chainIds, limit: options.historyLimit ?? 100 },
      required: true,
    });
    plan.push({
      path: ENDPOINTS.positions,
      params: { ...walletParams, chainIds, limit: options.positionsLimit ?? 50 },
      required: true,
    });
    plan.push({
      path: ENDPOINTS.trades,
      params: { ...walletParams, chainIds, limit: options.tradesLimit ?? 100 },
      required: true,
    });
  }
  plan.push({ path: ENDPOINTS.labels, params: walletParams, required: true });
  plan.push({ path: ENDPOINTS.funding, params: walletParams, required: true });
  plan.push({ path: ENDPOINTS.lighthouse, params: {}, required: true });

  if (options.probeOptionalEndpoints !== false) {
    for (const path of Object.values(OPTIONAL_ENDPOINTS)) {
      plan.push({ path, params: walletParams, required: false });
    }
  }

  const collected = await runPlan(client, plan, options.onProgress, concurrency);

  // Security lookups depend on what the wallet actually traded, so they are a
  // second phase. Busiest assets first — each call costs 10 credits.
  const assets = rankTradedAssets(collected, window, options.maxSecurityLookups ?? 25);
  const securityPlan: PlannedRequest[] = assets.map((asset) => ({
    path: ENDPOINTS.tokenSecurity,
    params: { address: asset.address, chainId: asset.chainId },
    required: false,
  }));
  const security = await runPlan(client, securityPlan, options.onProgress, concurrency);

  const sources: EvidenceSource[] = [...collected, ...security].map((result, index) =>
    toSource(result, index),
  );

  const draft: EvidenceBundle = {
    schema: BUNDLE_SCHEMA,
    referenceId,
    subject: { address, chains },
    window,
    sources,
    claims: [],
    derivedAt: (options.now ?? new Date()).toISOString(),
    derivationId: DERIVATION_ID,
    controlProof: options.controlProof ?? {
      message: controlProofMessage(referenceId),
      signature: '',
      signer: '',
    },
  };

  return { ...draft, claims: deriveClaims(draft) };
}

// ---------------------------------------------------------------------------

interface CollectedResult {
  path: string;
  params: Readonly<Record<string, string | number | boolean>>;
  fetchedAt: string;
  body?: unknown;
  failure?: { reason: string; status: number | null };
}

async function runPlan(
  client: MobulaClient,
  plan: readonly PlannedRequest[],
  onProgress: ((event: CollectProgress) => void) | undefined,
  concurrency = 3,
): Promise<CollectedResult[]> {
  const results = new Array<CollectedResult | undefined>(plan.length);
  let next = 0;
  let done = 0;

  const worker = async (): Promise<void> => {
    for (;;) {
      const slot = next++;
      const request = plan[slot];
      if (request === undefined) return;

      const attempt = await client.tryGet(request.path, request.params);
      const fetchedAt = attempt.ok ? attempt.value.fetchedAt : new Date().toISOString();
      const params = attempt.ok ? attempt.value.params : normalizeParams(request.params);

      results[slot] = attempt.ok
        ? { path: request.path, params, fetchedAt, body: attempt.value.body }
        : {
            path: request.path,
            params,
            fetchedAt,
            failure: { reason: attempt.error.message, status: attempt.error.status },
          };

      done += 1;
      onProgress?.({
        endpoint: `GET ${request.path}`,
        params,
        status: attempt.ok ? 'ok' : 'unavailable',
        httpStatus: attempt.ok ? attempt.value.status : attempt.error.status,
        done,
        total: plan.length,
      });
    }
  };

  await Promise.all(Array.from({ length: Math.min(concurrency, plan.length) }, worker));
  return results.filter((r): r is CollectedResult => r !== undefined);
}

function normalizeParams(params: QueryParams): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  for (const key of Object.keys(params).sort()) {
    const value = params[key];
    if (value !== undefined) out[key] = value;
  }
  return out;
}

function toSource(result: CollectedResult, index: number): EvidenceSource {
  const base = {
    index,
    endpoint: `GET ${result.path}`,
    params: result.params,
    fetchedAt: result.fetchedAt,
  };
  if (result.failure !== undefined) {
    return {
      ...base,
      // A source with no body still gets a digest, over the empty marker, so the
      // field is never absent and never a stand-in for real content.
      digest: canonicalDigest(null),
      unavailable:
        result.failure.status === null
          ? { reason: result.failure.reason }
          : { reason: result.failure.reason, status: result.failure.status },
    };
  }
  return { ...base, digest: canonicalDigest(result.body), body: result.body };
}

interface TradedAsset {
  address: string;
  chainId: string;
  volume: number;
}

/** Assets traded inside the window, busiest first, deduplicated across chains. */
function rankTradedAssets(
  collected: readonly CollectedResult[],
  window: TimeWindow,
  limit: number,
): TradedAsset[] {
  const fromMs = Date.parse(window.from);
  const toMs = Date.parse(window.to);
  const byKey = new Map<string, TradedAsset>();

  for (const result of collected) {
    if (result.path !== ENDPOINTS.positionsHistory || result.body === undefined) continue;
    const body = result.body as Paginated<PositionHistoryEntry>;
    for (const entry of body.data ?? []) {
      const exitMs = Date.parse(entry.cycle?.exitDate ?? '');
      if (!Number.isFinite(exitMs) || exitMs < fromMs || exitMs > toMs) continue;

      const address = entry.token?.address;
      const chain = normalizeChain(entry.token?.chainId);
      if (address === undefined || address === '' || chain === null) continue;

      const key = `${chain}|${address.toLowerCase()}`;
      const volume = (entry.cycle?.volumeBuyUSD ?? 0) + (entry.cycle?.volumeSellUSD ?? 0);
      const existing = byKey.get(key);
      if (existing === undefined) byKey.set(key, { address, chainId: chain, volume });
      else existing.volume += volume;
    }
  }

  return [...byKey.values()]
    .sort((a, b) => b.volume - a.volume || a.address.localeCompare(b.address))
    .slice(0, Math.max(0, limit));
}

function resolveWindow(options: BuildEvidenceOptions): TimeWindow {
  if (options.window !== undefined) return options.window;
  const to = options.now ?? new Date();
  const days = options.windowDays ?? DEFAULT_WINDOW_DAYS;
  return {
    from: new Date(to.getTime() - days * MS_PER_DAY).toISOString(),
    to: to.toISOString(),
  };
}
