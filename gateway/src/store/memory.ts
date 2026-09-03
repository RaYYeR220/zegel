import type { Hex } from 'viem';

import type { EnvelopeRecord, EnvelopeStore, StoreProbe } from './types.ts';

/**
 * In-memory storage. Used by the tests, and by the Worker entry point where there
 * is no filesystem.
 *
 * It is honest about what it is: `probe()` says the contents are lost on restart,
 * so a deployment that forgot to configure real storage shows up in `/health`
 * rather than looking fine until the first redeploy.
 */
export class MemoryEnvelopeStore implements EnvelopeStore {
  readonly kind = 'memory';
  readonly description = 'in-process map; contents are lost on restart';

  readonly #records = new Map<string, EnvelopeRecord>();
  readonly #nonces = new Map<string, bigint>();

  constructor(seed: readonly EnvelopeRecord[] = []) {
    for (const record of seed) this.#write(record);
  }

  async get(node: Hex): Promise<EnvelopeRecord | undefined> {
    return this.#records.get(key(node));
  }

  async put(record: EnvelopeRecord): Promise<void> {
    this.#write(record);
  }

  async list(): Promise<readonly EnvelopeRecord[]> {
    return [...this.#records.values()];
  }

  async lastNonce(node: Hex): Promise<bigint> {
    return this.#nonces.get(key(node)) ?? 0n;
  }

  async probe(): Promise<StoreProbe> {
    return {
      ok: true,
      detail: this.description,
      records: this.#records.size,
      latencyMs: 0,
    };
  }

  #write(record: EnvelopeRecord): void {
    const k = key(record.node);
    this.#records.set(k, record);
    const seen = this.#nonces.get(k) ?? 0n;
    if (record.nonce > seen) this.#nonces.set(k, record.nonce);
  }
}

function key(node: Hex): string {
  return node.toLowerCase();
}
