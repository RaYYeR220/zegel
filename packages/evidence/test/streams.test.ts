import { afterEach, describe, expect, it, vi } from 'vitest';

import type { MobulaClient } from '../src/client.js';
import { DEFAULT_POLL_INTERVAL_MS, openPositionsStream, streamCapability } from '../src/streams.js';
import type { WalletPosition } from '../src/upstream.js';

afterEach(() => {
  vi.useRealTimers();
});

/**
 * Mobula gates WebSocket streams behind a paid plan, so the failure mode that
 * matters is not "the stream broke" but "the product quietly pretended it was
 * live". These tests pin the visible degradation.
 */
describe('streamCapability', () => {
  it('reports streaming unavailable without a key, and names the polling interval', () => {
    const capability = streamCapability({ hasApiKey: false });
    expect(capability.available).toBe(false);
    expect(capability.reason).toBe('no-api-key');
    expect(capability.mode).toBe('poll');
    expect(capability.pollIntervalMs).toBe(DEFAULT_POLL_INTERVAL_MS);
    expect(capability.notice).toContain('Live streaming unavailable');
    expect(capability.notice).toContain('15s');
  });

  it('renders the configured interval into the notice a user sees', () => {
    expect(streamCapability({ hasApiKey: false }, 30_000).notice).toContain('30s');
    expect(streamCapability({ hasApiKey: false }, 5_000).notice).toContain('5s');
  });

  it('reports streaming available with a key and a WebSocket runtime', () => {
    const capability = streamCapability({ hasApiKey: true });
    expect(capability.available).toBe(typeof globalThis.WebSocket === 'function');
    if (capability.available) expect(capability.notice).toBe('Live streaming active');
  });
});

describe('openPositionsStream', () => {
  it('falls back to polling and says so', async () => {
    vi.useFakeTimers();
    const positions = [{ balance: 1 }] as WalletPosition[];
    const tryGet = vi.fn(() =>
      Promise.resolve({
        ok: true as const,
        value: {
          endpoint: 'GET /2/wallet/positions',
          params: {},
          status: 200,
          body: { data: positions },
          fetchedAt: '2026-09-03T00:00:00.000Z',
          rateLimit: {
            cost: 1,
            limit: 10_000,
            remaining: 9_999,
            endpoint: 'GET /2/wallet/positions',
            at: '2026-09-03T00:00:00.000Z',
            pod: null,
            upstreamMs: null,
          },
          attempts: 1,
        },
      }),
    );
    const client = { hasApiKey: false, tryGet } as unknown as MobulaClient;

    const seen: { mode: string; count: number }[] = [];
    const session = openPositionsStream(client, {
      wallet: '0xabc',
      chains: ['evm:1', 'solana'],
      pollIntervalMs: 1_000,
      onUpdate: (rows, mode) => seen.push({ mode, count: rows.length }),
    });

    expect(session.mode).toBe('poll');
    expect(session.notice).toContain('polling at 1s');

    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(2_100);
    session.stop();
    const after = seen.length;
    await vi.advanceTimersByTimeAsync(5_000);

    expect(after).toBeGreaterThanOrEqual(2);
    expect(seen.every((s) => s.mode === 'poll')).toBe(true);
    expect(seen.length).toBe(after);
    const [, params] = (tryGet.mock.calls[0] ?? []) as unknown as [string, Record<string, unknown>];
    expect(params).toMatchObject({ wallet: '0xabc', chainIds: 'evm:1,solana' });
  });

  it('reports poll failures instead of emitting an empty update', async () => {
    vi.useFakeTimers();
    const client = {
      hasApiKey: false,
      tryGet: vi.fn(() =>
        Promise.resolve({
          ok: false as const,
          error: Object.assign(new Error('GET /2/wallet/positions - HTTP 500'), { status: 500 }),
        }),
      ),
    } as unknown as MobulaClient;

    const updates: unknown[] = [];
    const errors: Error[] = [];
    const session = openPositionsStream(client, {
      wallet: '0xabc',
      pollIntervalMs: 1_000,
      onUpdate: (rows) => updates.push(rows),
      onError: (error) => errors.push(error),
    });

    await vi.advanceTimersByTimeAsync(0);
    session.stop();

    expect(updates).toHaveLength(0);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.message).toContain('HTTP 500');
  });
});
