import { describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_RETRY,
  DEMO_BASE_URL,
  MobulaError,
  PROD_BASE_URL,
  backoffDelay,
  createMobulaClient,
  isRetryableStatus,
} from '../src/client.js';
import type { RateLimitSnapshot } from '../src/ratelimit.js';

const RATE_HEADERS = {
  'x-ratelimit-cost': '10',
  'x-ratelimit-limit': '10000',
  'x-ratelimit-remaining': '9990',
  'x-pod-name': 'demo-api-75465b4fc4-8nqgz',
  'x-envoy-upstream-service-time': '1589',
};

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...RATE_HEADERS, ...headers },
  });
}

/** Replays a fixed script of responses and records the URLs it was asked for. */
function scriptedFetch(responses: (() => Response)[]): {
  fetch: typeof globalThis.fetch;
  calls: string[];
} {
  const calls: string[] = [];
  let i = 0;
  const fetch = ((input: RequestInfo | URL) => {
    calls.push(String(input));
    const next = responses[Math.min(i, responses.length - 1)];
    i += 1;
    if (next === undefined) throw new Error('no scripted response');
    return Promise.resolve(next());
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}

const noSleep = (): Promise<void> => Promise.resolve();

describe('host selection', () => {
  it('uses the keyless demo host by default', () => {
    expect(createMobulaClient({ apiKey: undefined, fetch: globalThis.fetch }).baseUrl).toBe(
      DEMO_BASE_URL,
    );
  });

  it('uses the keyed host when a key is supplied', () => {
    const client = createMobulaClient({ apiKey: 'k', fetch: globalThis.fetch });
    expect(client.baseUrl).toBe(PROD_BASE_URL);
    expect(client.hasApiKey).toBe(true);
  });

  it('sends the key as an Authorization header', async () => {
    let seen: Headers | undefined;
    const fetch = ((_input: RequestInfo | URL, init?: RequestInit) => {
      seen = new Headers(init?.headers);
      return Promise.resolve(jsonResponse({ data: [] }));
    }) as typeof globalThis.fetch;

    await createMobulaClient({ apiKey: 'secret', fetch }).get('/2/wallet/labels', { wallet: '0x1' });
    expect(seen?.get('authorization')).toBe('secret');
  });
});

describe('retry policy', () => {
  it('treats 429 and 5xx as retryable and everything else 4xx as terminal', () => {
    expect(isRetryableStatus(429)).toBe(true);
    expect(isRetryableStatus(500)).toBe(true);
    expect(isRetryableStatus(503)).toBe(true);
    expect(isRetryableStatus(400)).toBe(false);
    expect(isRetryableStatus(401)).toBe(false);
    expect(isRetryableStatus(404)).toBe(false);
  });

  it('retries a 500 and returns the recovered body', async () => {
    const { fetch, calls } = scriptedFetch([
      () => jsonResponse({ statusCode: 500, message: 'Internal server error' }, 500),
      () => jsonResponse({ statusCode: 500, message: 'Internal server error' }, 500),
      () => jsonResponse({ data: { securityScore: 97 } }),
    ]);
    const client = createMobulaClient({ fetch, sleep: noSleep, random: () => 0.5 });

    const result = await client.get<{ data: { securityScore: number } }>('/2/token/security', {
      address: 'So11111111111111111111111111111111111111112',
      chainId: 'solana',
    });
    expect(result.body.data.securityScore).toBe(97);
    expect(result.attempts).toBe(3);
    expect(calls).toHaveLength(3);
  });

  it('gives up after the configured number of attempts', async () => {
    const { fetch, calls } = scriptedFetch([() => jsonResponse({ message: 'nope' }, 503)]);
    const client = createMobulaClient({
      fetch,
      sleep: noSleep,
      random: () => 0,
      retry: { maxAttempts: 3 },
    });

    const attempt = await client.tryGet('/2/wallet/analysis', { wallet: '0x1' });
    expect(attempt.ok).toBe(false);
    if (!attempt.ok) {
      expect(attempt.error).toBeInstanceOf(MobulaError);
      expect(attempt.error.status).toBe(503);
      expect(attempt.error.retryable).toBe(true);
      expect(attempt.error.attempts).toBe(3);
    }
    expect(calls).toHaveLength(3);
  });

  it('does not retry a 400', async () => {
    const { fetch, calls } = scriptedFetch([
      () => jsonResponse({ statusCode: 400, message: 'Validation Error' }, 400),
    ]);
    const client = createMobulaClient({ fetch, sleep: noSleep });

    const attempt = await client.tryGet('/2/token/security', { blockchain: 'evm:8453' });
    expect(attempt.ok).toBe(false);
    expect(calls).toHaveLength(1);
  });

  it('retries a network failure', async () => {
    let first = true;
    const fetch = (() => {
      if (first) {
        first = false;
        return Promise.reject(new TypeError('fetch failed'));
      }
      return Promise.resolve(jsonResponse({ data: [] }));
    }) as typeof globalThis.fetch;

    const client = createMobulaClient({ fetch, sleep: noSleep, random: () => 0 });
    const result = await client.get('/2/wallet/labels', { wallet: '0x1' });
    expect(result.attempts).toBe(2);
  });

  it('waits the server-supplied retry-after instead of its own backoff', async () => {
    const sleep = vi.fn(() => Promise.resolve());
    const { fetch } = scriptedFetch([
      () => jsonResponse({ message: 'slow down' }, 429, { 'retry-after': '2' }),
      () => jsonResponse({ data: [] }),
    ]);
    const client = createMobulaClient({ fetch, sleep, random: () => 0.001 });

    await client.get('/2/wallet/positions', { wallet: '0x1' });
    expect(sleep).toHaveBeenCalledWith(2000);
  });

  it('backs off exponentially with full jitter', () => {
    for (let attempt = 0; attempt < 6; attempt++) {
      const ceiling = Math.min(
        DEFAULT_RETRY.maxDelayMs,
        DEFAULT_RETRY.baseDelayMs * 2 ** attempt,
      );
      expect(backoffDelay(attempt, DEFAULT_RETRY, 0)).toBe(0);
      expect(backoffDelay(attempt, DEFAULT_RETRY, 1)).toBe(ceiling);
      expect(backoffDelay(attempt, DEFAULT_RETRY, 0.5)).toBe(Math.round(ceiling / 2));
    }
    expect(backoffDelay(20, DEFAULT_RETRY, 1)).toBe(DEFAULT_RETRY.maxDelayMs);
  });
});

describe('rate limit meter', () => {
  it('surfaces the cost headers from every response', async () => {
    const { fetch } = scriptedFetch([() => jsonResponse({ data: [] })]);
    const client = createMobulaClient({ fetch, sleep: noSleep });
    const seen: RateLimitSnapshot[] = [];
    const unsubscribe = client.rateLimit.subscribe((s) => seen.push(s));

    await client.get('/2/token/security', { address: '0x1', chainId: 'evm:1' });
    await client.get('/2/token/security', { address: '0x2', chainId: 'evm:1' });
    unsubscribe();
    await client.get('/2/token/security', { address: '0x3', chainId: 'evm:1' });

    expect(seen).toHaveLength(2);
    expect(seen[0]?.cost).toBe(10);
    expect(seen[0]?.limit).toBe(10_000);
    expect(seen[0]?.remaining).toBe(9990);
    expect(seen[0]?.endpoint).toBe('GET /2/token/security');
    expect(seen[0]?.pod).toBe('demo-api-75465b4fc4-8nqgz');
    expect(seen[0]?.upstreamMs).toBe(1589);
    // The meter keeps counting after the subscriber walks away.
    expect(client.rateLimit.spent).toBe(30);
    expect(client.rateLimit.history).toHaveLength(3);
  });

  it('records the cost of a failed attempt too', async () => {
    const { fetch } = scriptedFetch([
      () => jsonResponse({ message: 'boom' }, 500),
      () => jsonResponse({ data: [] }),
    ]);
    const client = createMobulaClient({ fetch, sleep: noSleep, random: () => 0 });
    await client.get('/2/wallet/funding', { wallet: '0x1' });
    expect(client.rateLimit.history).toHaveLength(2);
  });

  it('survives a subscriber that throws', async () => {
    const { fetch } = scriptedFetch([() => jsonResponse({ data: [] })]);
    const client = createMobulaClient({ fetch, sleep: noSleep });
    client.rateLimit.subscribe(() => {
      throw new Error('meter blew up');
    });
    await expect(client.get('/2/wallet/labels', { wallet: '0x1' })).resolves.toBeDefined();
  });
});

describe('request shaping', () => {
  it('drops undefined params and sorts the rest', async () => {
    const { fetch, calls } = scriptedFetch([() => jsonResponse({ data: [] })]);
    const client = createMobulaClient({ fetch, sleep: noSleep });

    const result = await client.get('/2/wallet/positions-history', {
      wallet: '0xabc',
      limit: 20,
      chainIds: undefined,
    });
    expect(calls[0]).toBe(`${DEMO_BASE_URL}/api/2/wallet/positions-history?limit=20&wallet=0xabc`);
    expect(result.params).toEqual({ limit: 20, wallet: '0xabc' });
  });
});

describe('graphql', () => {
  it('unwraps data and raises declared errors', async () => {
    const ok = createMobulaClient({
      fetch: (() => Promise.resolve(jsonResponse({ data: { getNetworks: [] } }))) as typeof globalThis.fetch,
    });
    await expect(ok.graphql('{ getNetworks { id } }')).resolves.toEqual({ getNetworks: [] });

    const bad = createMobulaClient({
      fetch: (() =>
        Promise.resolve(jsonResponse({ errors: [{ message: 'Unknown field' }] }))) as typeof globalThis.fetch,
    });
    await expect(bad.graphql('{ nope }')).rejects.toThrow(/Unknown field/);
  });
});
