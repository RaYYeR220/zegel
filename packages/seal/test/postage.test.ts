import type { Bee } from '@ethersphere/bee-js';
import { describe, expect, it } from 'vitest';

import { PostageUnavailableError } from '../src/errors.js';
import {
  BLOCK_TIME_SECONDS,
  DEMO_BATCH_DEPTH,
  MIN_BATCH_DEPTH,
  amountForDuration,
  batchCostPlur,
  plurToBzz,
  quoteBatch,
  readStoragePrice,
  waitForUsableBatch,
} from '../src/postage.js';
import { FakeNotFound } from './fake-swarm.js';

function beeWithChainState(state: unknown): Bee {
  return {
    status: {
      getChainState: async () => {
        if (state instanceof Error) throw state;
        return state;
      },
    },
  } as unknown as Bee;
}

describe('postage', () => {
  it('uses depth 17 for demo-sized data, which is the minimum Bee allows', () => {
    expect(DEMO_BATCH_DEPTH).toBe(17);
    expect(MIN_BATCH_DEPTH).toBe(17);
  });

  it('reads the price live rather than assuming one', async () => {
    const bee = beeWithChainState({ chainTip: 41_000_000, block: 40_999_990, totalAmount: '1', currentPrice: 24_000 });

    const price = await readStoragePrice(bee);

    expect(price.currentPrice).toBe(24_000);
    expect(price.source).toBe('chainstate');
    expect(Date.parse(price.readAt)).not.toBeNaN();
  });

  it('says plainly when an endpoint does not expose the price', async () => {
    const bee = beeWithChainState(new FakeNotFound());

    await expect(readStoragePrice(bee)).rejects.toThrowError(PostageUnavailableError);
    await expect(readStoragePrice(bee)).rejects.toThrowError(/does not expose \/chainstate/);
  });

  it('converts a duration to an amount using the network block time', () => {
    const oneDay = 24 * 60 * 60;
    const blocks = oneDay / BLOCK_TIME_SECONDS.gnosis;

    expect(amountForDuration(24_000, oneDay, 'gnosis')).toBe(BigInt(24_000 * blocks));
    // Sepolia's slower blocks mean the same wall-clock TTL costs a third as much.
    expect(amountForDuration(24_000, oneDay, 'sepolia')).toBe(BigInt(24_000 * (oneDay / 15)));
  });

  it('rejects an implausible price instead of buying a batch that expires instantly', () => {
    expect(() => amountForDuration(0, 3_600)).toThrowError(PostageUnavailableError);
    expect(() => amountForDuration(24_000, 0)).toThrowError(/duration must be positive/);
  });

  it('charges for every chunk slot in the batch, used or not', () => {
    expect(batchCostPlur(17, 100n)).toBe(131_072n * 100n);
    expect(() => batchCostPlur(16, 100n)).toThrowError(/depth must be an integer/);
  });

  it('formats PLUR as xBZZ at 1e16 per token', () => {
    expect(plurToBzz(10n ** 16n)).toBe('1.000000');
    expect(plurToBzz(5n * 10n ** 15n)).toBe('0.500000');
  });

  it('quotes a batch from the live price without buying anything', async () => {
    const bee = beeWithChainState({ chainTip: 1, block: 1, totalAmount: '1', currentPrice: 24_000 });

    const quote = await quoteBatch(bee, { durationSeconds: 7 * 24 * 60 * 60 });

    expect(quote.depth).toBe(DEMO_BATCH_DEPTH);
    expect(quote.price.currentPrice).toBe(24_000);
    expect(quote.costPlur).toBe(batchCostPlur(quote.depth, quote.amount));
    expect(quote.costBzz).toBe(plurToBzz(quote.costPlur));
  });

  it('polls a fresh batch until Bee reports it usable', async () => {
    let calls = 0;
    const bee = {
      stamp: {
        get: async () => {
          calls += 1;
          if (calls < 3) throw new FakeNotFound();
          return { usable: calls >= 4 };
        },
      },
    } as unknown as Bee;

    await waitForUsableBatch(bee, 'a'.repeat(64), { pollMs: 0, sleep: async () => undefined });
    expect(calls).toBe(4);
  });

  it('gives up loudly rather than uploading against an unusable batch', async () => {
    const bee = { stamp: { get: async () => ({ usable: false }) } } as unknown as Bee;

    await expect(
      waitForUsableBatch(bee, 'a'.repeat(64), { timeoutMs: 0, pollMs: 0, sleep: async () => undefined }),
    ).rejects.toThrowError(/still not usable/);
  });
});
