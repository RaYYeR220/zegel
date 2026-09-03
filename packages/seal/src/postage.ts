import type { Bee } from '@ethersphere/bee-js';

import { PostageUnavailableError, isNotFound } from './errors.js';

/**
 * Postage is what keeps the sealed data alive.
 *
 * A Swarm batch has two independent dials: `depth` is how much data fits, `amount`
 * is how long it lives. When the batch expires the chunks stop being replicated and
 * the reference stops resolving — which reads, from the outside, exactly like a
 * revocation. Zegel therefore treats batch TTL as part of the reference's lifetime
 * and surfaces it, rather than letting a reference die quietly.
 */

/** Bee refuses anything below this; bucket depth is fixed at 16. */
export const MIN_BATCH_DEPTH = 17;

/** Depth 17 is right for a reference-sized payload. Effective capacity ~44 kB. */
export const DEMO_BATCH_DEPTH = 17;

/** Block times the `amount` arithmetic is denominated in. */
export const BLOCK_TIME_SECONDS: Record<'gnosis' | 'sepolia', number> = {
  gnosis: 5,
  sepolia: 15,
};

export type SwarmNetwork = keyof typeof BLOCK_TIME_SECONDS;

export interface StoragePrice {
  /** PLUR per chunk per block, live from `GET /chainstate`. Never hardcoded. */
  currentPrice: number;
  blockNumber: number;
  chainTip: number;
  /** Where the number came from, so a UI can show it is live. */
  source: 'chainstate';
  readAt: string;
}

/**
 * Reads the live storage price.
 *
 * The price moves with the redistribution game, so any constant baked into the
 * source is wrong within days: a batch bought at a stale price is under- or
 * over-funded, and under-funded means the reference dies early.
 */
export async function readStoragePrice(bee: Bee): Promise<StoragePrice> {
  let state;
  try {
    state = await bee.status.getChainState();
  } catch (cause) {
    if (isNotFound(cause)) {
      throw new PostageUnavailableError(
        'this endpoint does not expose /chainstate (the public gateway does not), so the live price cannot be read',
        { cause },
      );
    }
    throw new PostageUnavailableError('could not read /chainstate', { cause });
  }

  return {
    currentPrice: state.currentPrice,
    blockNumber: state.block,
    chainTip: state.chainTip,
    source: 'chainstate',
    readAt: new Date().toISOString(),
  };
}

/**
 * `amount` for a desired lifetime, from the live price.
 *
 * `amount` is per-chunk-per-block, so the lifetime in blocks is the duration
 * divided by the network's block time. Rounded up: paying for a fraction of a
 * block buys nothing.
 */
export function amountForDuration(
  currentPrice: number,
  durationSeconds: number,
  network: SwarmNetwork = 'gnosis',
): bigint {
  if (!Number.isFinite(currentPrice) || currentPrice <= 0) {
    throw new PostageUnavailableError(`implausible storage price: ${currentPrice}`);
  }
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    throw new PostageUnavailableError(`duration must be positive, got ${durationSeconds}`);
  }

  const blockTime = BLOCK_TIME_SECONDS[network];
  const blocks = BigInt(Math.ceil(durationSeconds / blockTime));
  return BigInt(Math.ceil(currentPrice)) * blocks;
}

/** Total PLUR locked by a batch: every chunk slot is paid for whether used or not. */
export function batchCostPlur(depth: number, amount: bigint): bigint {
  if (!Number.isInteger(depth) || depth < MIN_BATCH_DEPTH) {
    throw new PostageUnavailableError(`depth must be an integer >= ${MIN_BATCH_DEPTH}, got ${depth}`);
  }
  return (1n << BigInt(depth)) * amount;
}

/** 1 xBZZ is 1e16 PLUR. Formatted for display, not for arithmetic. */
export function plurToBzz(plur: bigint, decimals = 6): string {
  const scale = 10n ** 16n;
  const whole = plur / scale;
  const fraction = ((plur % scale) * 10n ** BigInt(decimals)) / scale;
  return `${whole}.${fraction.toString().padStart(decimals, '0')}`;
}

export interface BatchQuote {
  depth: number;
  amount: bigint;
  durationSeconds: number;
  network: SwarmNetwork;
  price: StoragePrice;
  costPlur: bigint;
  costBzz: string;
}

/** What a batch of this shape would cost right now. Read-only; buys nothing. */
export async function quoteBatch(
  bee: Bee,
  options: { depth?: number; durationSeconds: number; network?: SwarmNetwork },
): Promise<BatchQuote> {
  const network = options.network ?? 'gnosis';
  const depth = options.depth ?? DEMO_BATCH_DEPTH;
  const price = await readStoragePrice(bee);
  const amount = amountForDuration(price.currentPrice, options.durationSeconds, network);

  return {
    depth,
    amount,
    durationSeconds: options.durationSeconds,
    network,
    price,
    costPlur: batchCostPlur(depth, amount),
    costBzz: plurToBzz(batchCostPlur(depth, amount)),
  };
}

export interface WaitForUsableOptions {
  /** Bee needs roughly two minutes to make a fresh batch usable. */
  timeoutMs?: number;
  pollMs?: number;
  sleep?: (ms: number) => Promise<void>;
  onPoll?: (attempt: number) => void;
}

/**
 * Polls until a batch reports `usable`.
 *
 * bee-js 13.0.0 has its own `waitForUsable` but declares it private, so it cannot
 * be called from outside the class. This is the same loop, made reachable.
 */
export async function waitForUsableBatch(
  bee: Bee,
  batchId: string,
  options: WaitForUsableOptions = {},
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 180_000;
  const pollMs = options.pollMs ?? 3_000;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const deadline = Date.now() + timeoutMs;

  for (let attempt = 1; ; attempt++) {
    options.onPoll?.(attempt);

    try {
      const batch = await bee.stamp.get(batchId);
      if (batch.usable) return;
    } catch (cause) {
      // A batch that is not indexed yet 404s; anything else is a real failure.
      if (!isNotFound(cause)) {
        throw new PostageUnavailableError(`could not read batch ${batchId}`, { cause });
      }
    }

    if (Date.now() >= deadline) {
      throw new PostageUnavailableError(`batch ${batchId} was still not usable after ${timeoutMs}ms`);
    }
    await sleep(pollMs);
  }
}

export interface EnsureBatchOptions {
  /** Use this batch if it exists and is usable. */
  batchId?: string;
  depth?: number;
  durationSeconds?: number;
  network?: SwarmNetwork;
  label?: string;
  /** Buying spends real xBZZ, so it is opt-in. */
  allowPurchase?: boolean;
  waitForUsable?: WaitForUsableOptions;
  onProgress?: (message: string) => void;
}

/**
 * Resolves a usable postage batch, reusing before buying.
 *
 * Order is deliberate: an explicitly configured batch, then any usable batch the
 * node already owns, and only then a purchase — and a purchase only when the
 * caller opted in. Buying silently is how a hackathon node ends up with a dozen
 * abandoned batches and no xBZZ.
 */
export async function ensureUsableBatch(bee: Bee, options: EnsureBatchOptions = {}): Promise<string> {
  const depth = options.depth ?? DEMO_BATCH_DEPTH;
  const report = options.onProgress ?? (() => undefined);

  if (options.batchId) {
    const batch = await bee.stamp.get(options.batchId).catch((cause: unknown) => {
      throw new PostageUnavailableError(`configured batch ${options.batchId} is not on this node`, { cause });
    });
    if (!batch.usable) {
      report(`batch ${options.batchId} is not usable yet, waiting`);
      await waitForUsableBatch(bee, options.batchId, options.waitForUsable);
    }
    return options.batchId;
  }

  const existing = await bee.stamp.getAll().catch(() => []);
  const reusable = existing.find((batch) => batch.usable && batch.depth >= depth && batch.usage < 1);
  if (reusable) {
    report(`reusing batch ${reusable.batchID.toHex()} (${reusable.usageText} used)`);
    return reusable.batchID.toHex();
  }

  if (!options.allowPurchase) {
    throw new PostageUnavailableError(
      'no usable batch on this node and purchasing was not enabled (pass allowPurchase to spend xBZZ)',
    );
  }

  const durationSeconds = options.durationSeconds ?? 7 * 24 * 60 * 60;
  const quote = await quoteBatch(bee, { depth, durationSeconds, ...(options.network ? { network: options.network } : {}) });
  report(`buying depth-${depth} batch for ${quote.costBzz} xBZZ at live price ${quote.price.currentPrice}`);

  const created = await bee.stamp.create(quote.amount.toString(), depth, {
    label: options.label ?? 'zegel-seal',
  });
  const batchId = created.toHex();

  report(`batch ${batchId} created, waiting for it to become usable`);
  await waitForUsableBatch(bee, batchId, options.waitForUsable);
  return batchId;
}
