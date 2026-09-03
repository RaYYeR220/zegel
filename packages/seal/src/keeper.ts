import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import type { SealReceipt } from './receipt.js';

/**
 * A sink for seal receipts.
 *
 * `SealClient` cannot be constructed without one. That is deliberate: the ACT
 * history address is unrecoverable, and "I'll persist it at the call site" is
 * exactly the intention that gets dropped during a refactor. Making the sink a
 * required constructor argument moves the mistake from runtime to compile time.
 *
 * The sink is awaited before `seal` resolves, so a receipt is durable before the
 * caller can act on it. A throwing sink fails the seal — loudly, on purpose.
 */
export type ReceiptKeeper = (receipt: SealReceipt) => void | Promise<void>;

export interface MemoryKeeper {
  (receipt: SealReceipt): void;
  /** Everything kept so far, oldest first. */
  readonly receipts: readonly SealReceipt[];
}

/** In-memory sink. Fine for tests and a single-process demo; loses everything on exit. */
export function memoryKeeper(): MemoryKeeper {
  const receipts: SealReceipt[] = [];
  const keeper = ((receipt: SealReceipt) => {
    receipts.push(receipt);
  }) as MemoryKeeper & { receipts: readonly SealReceipt[] };

  Object.defineProperty(keeper, 'receipts', { get: () => receipts });
  return keeper;
}

/**
 * Append-only JSON-lines sink.
 *
 * Append rather than rewrite: an overwrite that fails halfway destroys the
 * history addresses of every earlier seal, which is the failure this file exists
 * to prevent.
 */
export function fileKeeper(path: string): ReceiptKeeper {
  return async (receipt) => {
    await mkdir(dirname(path), { recursive: true });
    await appendFile(path, `${JSON.stringify(receipt)}\n`, 'utf8');
  };
}

/** Reads a `fileKeeper` log back. */
export async function readKeptReceipts(path: string): Promise<SealReceipt[]> {
  const text = await readFile(path, 'utf8').catch(() => '');
  return text
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as SealReceipt);
}

/** Fans a receipt out to several sinks; all must succeed. */
export function allKeepers(...keepers: readonly ReceiptKeeper[]): ReceiptKeeper {
  return async (receipt) => {
    for (const keeper of keepers) await keeper(receipt);
  };
}
