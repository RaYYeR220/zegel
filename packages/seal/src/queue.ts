/**
 * Serialised, rate-floored task queue for ACT grantee patches.
 *
 * Bee stores each ACT history version in a mantaray trie keyed by the wall-clock
 * second of the write. Two patches landing inside the same second collide on that
 * key and the second one fails with an invalid-input error — so grantee updates
 * are not merely slow to batch, they are lossy if issued concurrently.
 *
 * The floor is measured from the *completion* of the previous task rather than its
 * start. That is the conservative reading: the timestamp Bee keys on is set while
 * it processes the write, not when we dispatched it.
 */

/** One second plus a margin for clock skew between us and the Bee node. */
export const MIN_GRANTEE_PATCH_INTERVAL_MS = 1_100;

export interface PatchQueueOptions {
  /** Minimum gap between the end of one task and the start of the next. */
  minIntervalMs?: number;
  /** Injectable clock, for deterministic tests. */
  now?: () => number;
  /** Injectable delay, for deterministic tests. */
  sleep?: (ms: number) => Promise<void>;
}

export type DepthListener = (depth: number) => void;

/**
 * A queue whose depth is observable.
 *
 * The depth is exposed because a grant of five verifiers takes five and a half
 * seconds and a UI that shows nothing for that long looks broken. Callers can
 * render "3 pending" instead of guessing.
 */
export class PatchQueue {
  readonly minIntervalMs: number;

  #now: () => number;
  #sleep: (ms: number) => Promise<void>;
  #tail: Promise<unknown> = Promise.resolve();
  #pending = 0;
  #lastFinishedAt: number | null = null;
  #listeners = new Set<DepthListener>();

  constructor(options: PatchQueueOptions = {}) {
    this.minIntervalMs = options.minIntervalMs ?? MIN_GRANTEE_PATCH_INTERVAL_MS;
    this.#now = options.now ?? (() => Date.now());
    this.#sleep = options.sleep ?? defaultSleep;
  }

  /** Tasks queued but not yet finished, including the one currently running. */
  get depth(): number {
    return this.#pending;
  }

  /** Milliseconds until the next task may start. Zero when the queue is idle and cold. */
  get waitMs(): number {
    if (this.#lastFinishedAt === null) return 0;
    return Math.max(0, this.minIntervalMs - (this.#now() - this.#lastFinishedAt));
  }

  /** Subscribe to depth changes. Returns an unsubscribe function. */
  onDepthChange(listener: DepthListener): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  /**
   * Runs `task` after every previously queued task, respecting the interval floor.
   *
   * A rejected task does not stall the queue and does not reset the floor to zero:
   * a failed patch may still have been written by the time it errored.
   */
  enqueue<T>(task: () => Promise<T>): Promise<T> {
    this.#setDepth(this.#pending + 1);

    const run = this.#tail.then(async (): Promise<T> => {
      const wait = this.waitMs;
      if (wait > 0) await this.#sleep(wait);

      try {
        return await task();
      } finally {
        this.#lastFinishedAt = this.#now();
        this.#setDepth(this.#pending - 1);
      }
    });

    // The chain must not be poisoned by a rejection, or every later task inherits it.
    this.#tail = run.then(
      () => undefined,
      () => undefined,
    );

    return run;
  }

  /** Resolves once everything currently queued has settled. */
  async drain(): Promise<void> {
    await this.#tail;
  }

  #setDepth(next: number): void {
    this.#pending = next;
    for (const listener of this.#listeners) listener(next);
  }
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
