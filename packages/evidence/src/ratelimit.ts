/**
 * Mobula returns `x-ratelimit-cost` / `-limit` / `-remaining` on every response.
 * Credits are the real constraint on this product (a full evidence bundle costs
 * tens of credits), so the numbers are pushed to whoever is watching instead of
 * being thrown away — the app renders them as a live budget meter.
 */

export interface RateLimitSnapshot {
  /** Credits the request that produced this snapshot consumed. */
  cost: number | null;
  /** Credit allowance for the key. */
  limit: number | null;
  /** Credits left. */
  remaining: number | null;
  /** Endpoint that reported it, e.g. `GET /2/wallet/positions`. */
  endpoint: string;
  /** ISO 8601. */
  at: string;
  /** Mobula pod that served it — useful when one pod is degraded. */
  pod: string | null;
  /** Upstream service time in ms, when reported. */
  upstreamMs: number | null;
}

export type RateLimitListener = (snapshot: RateLimitSnapshot) => void;

export interface RateLimitObserver {
  /** Most recent snapshot, or `null` before the first response. */
  readonly latest: RateLimitSnapshot | null;
  /** Total credits this client has spent since it was created. */
  readonly spent: number;
  /** Every snapshot, oldest first, capped at `historyLimit`. */
  readonly history: readonly RateLimitSnapshot[];
  subscribe(listener: RateLimitListener): () => void;
  /** Internal — called by the client for each response. */
  record(snapshot: RateLimitSnapshot): void;
}

const parseIntOrNull = (v: string | null): number | null => {
  if (v === null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

export function createRateLimitObserver(historyLimit = 200): RateLimitObserver {
  const listeners = new Set<RateLimitListener>();
  const history: RateLimitSnapshot[] = [];
  let latest: RateLimitSnapshot | null = null;
  let spent = 0;

  return {
    get latest() {
      return latest;
    },
    get spent() {
      return spent;
    },
    get history() {
      return history;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    record(snapshot) {
      latest = snapshot;
      spent += snapshot.cost ?? 0;
      history.push(snapshot);
      if (history.length > historyLimit) history.splice(0, history.length - historyLimit);
      for (const l of listeners) {
        // One bad meter subscriber must not fail an evidence collection.
        try {
          l(snapshot);
        } catch {
          /* ignore */
        }
      }
    },
  };
}

export function snapshotFromHeaders(
  headers: Headers,
  endpoint: string,
  at: string,
): RateLimitSnapshot {
  return {
    cost: parseIntOrNull(headers.get('x-ratelimit-cost')),
    limit: parseIntOrNull(headers.get('x-ratelimit-limit')),
    remaining: parseIntOrNull(headers.get('x-ratelimit-remaining')),
    endpoint,
    at,
    pod: headers.get('x-pod-name'),
    upstreamMs: parseIntOrNull(headers.get('x-envoy-upstream-service-time')),
  };
}
