import type { MobulaClient } from './client.js';
import { ENDPOINTS } from './endpoints.js';
import { toQueryChain } from './chains.js';
import type { ChainId } from './sdk.js';
import type { Envelope, WalletPosition } from './upstream.js';

/**
 * Mobula gates every WebSocket stream behind the Growth plan. Without such a key
 * there is no live feed at all, so the product must degrade where a user can see
 * it: a stream session always reports which mode it is running in and carries a
 * sentence the UI prints verbatim. Silently falling back to polling and calling
 * it "live" would be a lie, and the honesty is the point of the product.
 */

export const DEFAULT_POLL_INTERVAL_MS = 15_000;
export const WS_URL = 'wss://api.mobula.io';

export type StreamMode = 'websocket' | 'poll';

export interface StreamCapability {
  available: boolean;
  mode: StreamMode;
  /** Machine-readable cause, for tests and telemetry. */
  reason: 'ok' | 'no-api-key' | 'no-websocket-runtime';
  /** Rendered to the user as-is. */
  notice: string;
  pollIntervalMs: number;
}

export function streamCapability(
  client: Pick<MobulaClient, 'hasApiKey'>,
  pollIntervalMs: number = DEFAULT_POLL_INTERVAL_MS,
): StreamCapability {
  const seconds = Math.round(pollIntervalMs / 1000);
  if (!client.hasApiKey) {
    return {
      available: false,
      mode: 'poll',
      reason: 'no-api-key',
      notice: `Live streaming unavailable (Mobula WebSocket requires a paid plan key) - polling at ${seconds}s`,
      pollIntervalMs,
    };
  }
  if (typeof globalThis.WebSocket !== 'function') {
    return {
      available: false,
      mode: 'poll',
      reason: 'no-websocket-runtime',
      notice: `Live streaming unavailable (no WebSocket in this runtime) - polling at ${seconds}s`,
      pollIntervalMs,
    };
  }
  return {
    available: true,
    mode: 'websocket',
    reason: 'ok',
    notice: 'Live streaming active',
    pollIntervalMs,
  };
}

export interface PositionsStreamOptions {
  wallet: string;
  chains?: readonly ChainId[] | undefined;
  pollIntervalMs?: number | undefined;
  /** Cost attribution tag; shows up per-feature in `/2/usage`. */
  tag?: string | undefined;
  onUpdate: (positions: WalletPosition[], mode: StreamMode) => void;
  onError?: ((error: Error) => void) | undefined;
}

export interface StreamSession {
  readonly capability: StreamCapability;
  readonly mode: StreamMode;
  /** The sentence to show the user while this session is running. */
  readonly notice: string;
  stop(): void;
}

/**
 * Live wallet positions, or the visibly-degraded polling equivalent.
 * The caller gets the same callback either way and always knows which it got.
 */
export function openPositionsStream(
  client: MobulaClient,
  options: PositionsStreamOptions,
): StreamSession {
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const capability = streamCapability(client, pollIntervalMs);

  if (capability.available) return openWebSocketSession(client, options, capability);
  return openPollingSession(client, options, capability);
}

function openWebSocketSession(
  client: MobulaClient,
  options: PositionsStreamOptions,
  capability: StreamCapability,
): StreamSession {
  const socket = new globalThis.WebSocket(WS_URL);
  let keepalive: ReturnType<typeof setInterval> | undefined;

  socket.addEventListener('open', () => {
    socket.send(
      JSON.stringify({
        type: 'positions',
        authorization: client.apiKey,
        payload: {
          wallet: options.wallet,
          ...(options.chains === undefined
            ? {}
            : { chainIds: options.chains.map(toQueryChain).join(',') }),
          ...(options.tag === undefined ? {} : { tag: options.tag }),
        },
      }),
    );
    keepalive = setInterval(() => {
      socket.send(JSON.stringify({ event: 'ping' }));
    }, 30_000);
  });

  socket.addEventListener('message', (event: MessageEvent) => {
    try {
      const parsed = JSON.parse(String(event.data)) as {
        event?: string;
        message?: string;
        data?: WalletPosition[];
        payload?: { data?: WalletPosition[] };
      };
      if (parsed.event === 'error') {
        options.onError?.(new Error(parsed.message ?? 'stream error'));
        return;
      }
      const positions = parsed.data ?? parsed.payload?.data;
      if (positions !== undefined) options.onUpdate(positions, 'websocket');
    } catch (error) {
      options.onError?.(error as Error);
    }
  });

  socket.addEventListener('error', () => {
    options.onError?.(new Error('websocket transport error'));
  });

  return {
    capability,
    mode: 'websocket',
    notice: capability.notice,
    stop() {
      if (keepalive !== undefined) clearInterval(keepalive);
      socket.close();
    },
  };
}

function openPollingSession(
  client: MobulaClient,
  options: PositionsStreamOptions,
  capability: StreamCapability,
): StreamSession {
  let stopped = false;

  const tick = async (): Promise<void> => {
    const chains = options.chains ?? [];
    const params =
      chains.length === 0 ? {} : { chainIds: chains.map(toQueryChain).join(',') };
    const attempt = await client.tryGet<Envelope<WalletPosition[]>>(ENDPOINTS.positions, {
      wallet: options.wallet,
      ...params,
    });
    if (stopped) return;
    if (attempt.ok) options.onUpdate(attempt.value.body.data ?? [], 'poll');
    else options.onError?.(attempt.error);
  };

  void tick();
  const timer = setInterval(() => {
    void tick();
  }, capability.pollIntervalMs);

  return {
    capability,
    mode: 'poll',
    notice: capability.notice,
    stop() {
      stopped = true;
      clearInterval(timer);
    },
  };
}
