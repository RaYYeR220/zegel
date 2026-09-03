import {
  createRateLimitObserver,
  snapshotFromHeaders,
  type RateLimitObserver,
  type RateLimitSnapshot,
} from './ratelimit.js';

/** No key required, no signup. Roughly 40 endpoints answer 200 here. */
export const DEMO_BASE_URL = 'https://demo-api.mobula.io';
/** Keyed host. Without a key it answers 429, not 401. */
export const PROD_BASE_URL = 'https://api.mobula.io';
/** Open over HTTP with no auth at all. Subscriptions over wss do need a key. */
export const GRAPHQL_URL = 'https://graphql.mobula.io/graphql';

export type QueryParams = Record<string, string | number | boolean | undefined>;

export interface RetryPolicy {
  /** Total attempts including the first. */
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  /** Per-attempt request timeout. */
  timeoutMs: number;
}

export const DEFAULT_RETRY: RetryPolicy = {
  maxAttempts: 5,
  baseDelayMs: 500,
  maxDelayMs: 8_000,
  timeoutMs: 30_000,
};

export interface MobulaClientOptions {
  apiKey?: string | undefined;
  baseUrl?: string | undefined;
  graphqlUrl?: string | undefined;
  fetch?: typeof globalThis.fetch | undefined;
  retry?: Partial<RetryPolicy> | undefined;
  /** Injectable so backoff is reproducible under test. */
  random?: (() => number) | undefined;
  sleep?: ((ms: number) => Promise<void>) | undefined;
}

/** A successful upstream call, with everything a verifier needs to reproduce it. */
export interface MobulaOk<T> {
  endpoint: string;
  params: Readonly<Record<string, string | number | boolean>>;
  status: number;
  body: T;
  /** ISO 8601. */
  fetchedAt: string;
  rateLimit: RateLimitSnapshot;
  attempts: number;
}

export class MobulaError extends Error {
  readonly endpoint: string;
  readonly status: number | null;
  readonly retryable: boolean;
  readonly attempts: number;
  readonly body: unknown;

  constructor(init: {
    message: string;
    endpoint: string;
    status: number | null;
    retryable: boolean;
    attempts: number;
    body?: unknown;
  }) {
    super(init.message);
    this.name = 'MobulaError';
    this.endpoint = init.endpoint;
    this.status = init.status;
    this.retryable = init.retryable;
    this.attempts = init.attempts;
    this.body = init.body;
  }
}

export type MobulaAttempt<T> =
  | { ok: true; value: MobulaOk<T> }
  | { ok: false; error: MobulaError };

/**
 * 429 and 5xx are transient. Mobula's demo host serves real 500s on
 * `/2/wallet/analysis`, `/2/wallet/defi-positions` and `/1/wallet/history`, and
 * those sometimes recover on a retry. Every other 4xx is our fault — bad params,
 * bad key — and retrying only burns credits.
 */
export function isRetryableStatus(status: number): boolean {
  return status === 429 || status === 408 || status >= 500;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/** Exponential backoff with full jitter: `rand * min(cap, base * 2^n)`. */
export function backoffDelay(attempt: number, policy: RetryPolicy, rand: number): number {
  const ceiling = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** attempt);
  return Math.round(rand * ceiling);
}

function cleanParams(params: QueryParams): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  for (const key of Object.keys(params).sort()) {
    const v = params[key];
    if (v !== undefined) out[key] = v;
  }
  return out;
}

export interface MobulaClient {
  readonly baseUrl: string;
  readonly graphqlUrl: string;
  readonly hasApiKey: boolean;
  /** The configured key, needed to open a WebSocket subscription. */
  readonly apiKey: string | undefined;
  readonly rateLimit: RateLimitObserver;
  /** Throws `MobulaError` on failure. */
  get<T = unknown>(path: string, params?: QueryParams): Promise<MobulaOk<T>>;
  /** Never throws — the caller decides whether a failure is fatal. */
  tryGet<T = unknown>(path: string, params?: QueryParams): Promise<MobulaAttempt<T>>;
  /** Open GraphQL endpoint. */
  graphql<T = unknown>(query: string, variables?: Record<string, unknown>): Promise<T>;
}

export function createMobulaClient(options: MobulaClientOptions = {}): MobulaClient {
  const apiKey = options.apiKey ?? readEnv('MOBULA_API_KEY');
  const baseUrl = (options.baseUrl ?? (apiKey === undefined ? DEMO_BASE_URL : PROD_BASE_URL)).replace(
    /\/+$/,
    '',
  );
  const graphqlUrl = options.graphqlUrl ?? GRAPHQL_URL;
  const doFetch = options.fetch ?? globalThis.fetch;
  const policy: RetryPolicy = { ...DEFAULT_RETRY, ...options.retry };
  const random = options.random ?? Math.random;
  const sleep = options.sleep ?? defaultSleep;
  const rateLimit = createRateLimitObserver();

  if (typeof doFetch !== 'function') {
    throw new TypeError('no fetch implementation available; pass one via options.fetch');
  }

  const authHeaders = (): Record<string, string> => {
    const h: Record<string, string> = { accept: 'application/json' };
    if (apiKey !== undefined) h['Authorization'] = apiKey;
    return h;
  };

  async function request<T>(path: string, params: QueryParams = {}): Promise<MobulaOk<T>> {
    const clean = cleanParams(params);
    const endpoint = `GET ${path}`;
    const url = new URL(`${baseUrl}/api${path}`);
    for (const [k, v] of Object.entries(clean)) url.searchParams.set(k, String(v));

    let lastError: MobulaError | null = null;
    let serverRetryAfterMs: number | null = null;

    for (let attempt = 0; attempt < policy.maxAttempts; attempt++) {
      if (attempt > 0) {
        await sleep(serverRetryAfterMs ?? backoffDelay(attempt - 1, policy, random()));
        serverRetryAfterMs = null;
      }

      let response: Response;
      try {
        response = await doFetch(url, {
          method: 'GET',
          headers: authHeaders(),
          signal: AbortSignal.timeout(policy.timeoutMs),
        });
      } catch (cause) {
        lastError = new MobulaError({
          message: `${endpoint} - network failure: ${(cause as Error).message}`,
          endpoint,
          status: null,
          retryable: true,
          attempts: attempt + 1,
        });
        continue;
      }

      const fetchedAt = new Date().toISOString();
      const snapshot = snapshotFromHeaders(response.headers, endpoint, fetchedAt);
      rateLimit.record(snapshot);

      if (response.ok) {
        const body = (await response.json()) as T;
        return {
          endpoint,
          params: clean,
          status: response.status,
          body,
          fetchedAt,
          rateLimit: snapshot,
          attempts: attempt + 1,
        };
      }

      const text = await response.text().catch(() => '');
      const retryable = isRetryableStatus(response.status);
      lastError = new MobulaError({
        message: `${endpoint} - HTTP ${response.status}${text === '' ? '' : `: ${truncate(text)}`}`,
        endpoint,
        status: response.status,
        retryable,
        attempts: attempt + 1,
        body: parseMaybeJson(text),
      });
      serverRetryAfterMs = parseRetryAfter(response.headers);
      if (!retryable) break;
    }

    throw (
      lastError ??
      new MobulaError({
        message: `${endpoint} - exhausted retries`,
        endpoint,
        status: null,
        retryable: true,
        attempts: policy.maxAttempts,
      })
    );
  }

  return {
    baseUrl,
    graphqlUrl,
    hasApiKey: apiKey !== undefined,
    apiKey,
    rateLimit,
    get: request,
    async tryGet<T>(path: string, params: QueryParams = {}): Promise<MobulaAttempt<T>> {
      try {
        return { ok: true, value: await request<T>(path, params) };
      } catch (error) {
        if (error instanceof MobulaError) return { ok: false, error };
        throw error;
      }
    },
    async graphql<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
      const endpoint = 'POST /graphql';
      const response = await doFetch(graphqlUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...authHeaders() },
        body: JSON.stringify({ query, variables }),
        signal: AbortSignal.timeout(policy.timeoutMs),
      });
      rateLimit.record(snapshotFromHeaders(response.headers, endpoint, new Date().toISOString()));
      if (!response.ok) {
        throw new MobulaError({
          message: `${endpoint} - HTTP ${response.status}`,
          endpoint,
          status: response.status,
          retryable: isRetryableStatus(response.status),
          attempts: 1,
        });
      }
      const payload = (await response.json()) as {
        data?: T;
        errors?: { message: string }[];
      };
      if (payload.errors !== undefined && payload.errors.length > 0) {
        throw new MobulaError({
          message: `${endpoint} - ${payload.errors.map((e) => e.message).join('; ')}`,
          endpoint,
          status: response.status,
          retryable: false,
          attempts: 1,
          body: payload,
        });
      }
      return payload.data as T;
    },
  };
}

function readEnv(name: string): string | undefined {
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process
    ?.env;
  const value = env?.[name];
  return value === undefined || value === '' ? undefined : value;
}

function parseRetryAfter(headers: Headers): number | null {
  const raw = headers.get('retry-after');
  if (raw === null) return null;
  const seconds = Number(raw);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : null;
}

function truncate(text: string): string {
  return text.length > 300 ? `${text.slice(0, 300)}...` : text;
}

function parseMaybeJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}
