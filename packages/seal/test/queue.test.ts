import { describe, expect, it } from 'vitest';

import { MIN_GRANTEE_PATCH_INTERVAL_MS, PatchQueue } from '../src/queue.js';

/**
 * A virtual clock. The rate floor is over a second, and waiting for it in real
 * time would make the suite slow enough that nobody runs it.
 */
function virtualClock(): { now: () => number; sleep: (ms: number) => Promise<void>; elapsed: () => number } {
  let t = 1_000_000;
  return {
    now: () => t,
    sleep: async (ms: number) => {
      t += ms;
    },
    elapsed: () => t - 1_000_000,
  };
}

describe('grantee patch queue', () => {
  it('defaults to a floor above the one-second mantaray key collision', () => {
    expect(MIN_GRANTEE_PATCH_INTERVAL_MS).toBeGreaterThan(1_000);
    expect(new PatchQueue().minIntervalMs).toBe(MIN_GRANTEE_PATCH_INTERVAL_MS);
  });

  it('runs tasks one at a time, in order', async () => {
    const clock = virtualClock();
    const queue = new PatchQueue({ ...clock });
    const events: string[] = [];

    const tasks = ['a', 'b', 'c'].map((name) =>
      queue.enqueue(async () => {
        events.push(`start:${name}`);
        await Promise.resolve();
        events.push(`end:${name}`);
        return name;
      }),
    );

    await expect(Promise.all(tasks)).resolves.toEqual(['a', 'b', 'c']);
    expect(events).toEqual(['start:a', 'end:a', 'start:b', 'end:b', 'start:c', 'end:c']);
  });

  it('leaves at least the floor between consecutive patches', async () => {
    const clock = virtualClock();
    const queue = new PatchQueue({ ...clock });
    const startedAt: number[] = [];

    await Promise.all(
      [0, 1, 2, 3].map(() => queue.enqueue(async () => void startedAt.push(clock.now()))),
    );

    expect(startedAt).toHaveLength(4);
    for (let i = 1; i < startedAt.length; i++) {
      expect((startedAt[i] as number) - (startedAt[i - 1] as number)).toBeGreaterThanOrEqual(
        MIN_GRANTEE_PATCH_INTERVAL_MS,
      );
    }
    // Three gaps, not four: the first patch is not made to wait.
    expect(clock.elapsed()).toBe(3 * MIN_GRANTEE_PATCH_INTERVAL_MS);
  });

  it('does not delay the first patch on a cold queue', async () => {
    const clock = virtualClock();
    const queue = new PatchQueue({ ...clock });

    expect(queue.waitMs).toBe(0);
    await queue.enqueue(async () => undefined);
    expect(clock.elapsed()).toBe(0);
  });

  it('reports how long the next patch must wait', async () => {
    const clock = virtualClock();
    const queue = new PatchQueue({ ...clock });

    await queue.enqueue(async () => undefined);
    expect(queue.waitMs).toBe(MIN_GRANTEE_PATCH_INTERVAL_MS);
  });

  it('exposes its depth so a UI can show pending work', async () => {
    const clock = virtualClock();
    const queue = new PatchQueue({ ...clock });
    const seen: number[] = [];
    const unsubscribe = queue.onDepthChange((depth) => seen.push(depth));

    const all = Promise.all([0, 1, 2].map(() => queue.enqueue(async () => undefined)));
    expect(queue.depth).toBe(3);

    await all;
    expect(queue.depth).toBe(0);
    expect(seen).toEqual([1, 2, 3, 2, 1, 0]);

    unsubscribe();
    await queue.enqueue(async () => undefined);
    expect(seen).toEqual([1, 2, 3, 2, 1, 0]);
  });

  it('keeps running after a task rejects, and still honours the floor', async () => {
    const clock = virtualClock();
    const queue = new PatchQueue({ ...clock });

    const failed = queue.enqueue(async () => {
      throw new Error('mantaray save failed: invalid input');
    });
    const after = queue.enqueue(async () => clock.now());

    await expect(failed).rejects.toThrowError(/invalid input/);
    await expect(after).resolves.toBe(1_000_000 + MIN_GRANTEE_PATCH_INTERVAL_MS);
    expect(queue.depth).toBe(0);
  });

  it('honours a real wall-clock gap', async () => {
    const queue = new PatchQueue({ minIntervalMs: 40 });
    const stamps: number[] = [];

    await Promise.all([0, 1, 2].map(() => queue.enqueue(async () => void stamps.push(Date.now()))));

    expect((stamps[1] as number) - (stamps[0] as number)).toBeGreaterThanOrEqual(35);
    expect((stamps[2] as number) - (stamps[1] as number)).toBeGreaterThanOrEqual(35);
  });

  it('drains to a settled state even when a task threw', async () => {
    const clock = virtualClock();
    const queue = new PatchQueue({ ...clock });

    queue.enqueue(async () => {
      throw new Error('boom');
    }).catch(() => undefined);
    queue.enqueue(async () => undefined);

    await queue.drain();
    expect(queue.depth).toBe(0);
  });
});
