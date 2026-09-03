import type { Bee } from '@ethersphere/bee-js';

import type { SealCapabilities, SwarmBackend } from '../src/backend.js';
import { granteeFromPrivateKey, type GranteePublicKey } from '../src/pubkey.js';

/**
 * An in-memory stand-in for a Bee node.
 *
 * It models only the two behaviours the sealing layer depends on: an ACT read
 * without the right coordinates answers 404, and a grantee patch returns fresh
 * reference and history addresses. Everything beyond that is exercised by the live
 * gateway test rather than imitated here, so this double cannot drift into
 * asserting a Swarm that does not exist.
 */

export class FakeNotFound extends Error {
  readonly status = 404;

  constructor(message = 'Not Found') {
    super(message);
  }
}

export class FakeServerError extends Error {
  readonly status = 502;

  constructor(message = 'Bad Gateway') {
    super(message);
  }
}

export const PUBLISHER_KEY: GranteePublicKey = granteeFromPrivateKey(`0x${'01'.repeat(32)}`);
export const VERIFIER_KEY: GranteePublicKey = granteeFromPrivateKey(`0x${'02'.repeat(32)}`);
export const OTHER_KEY: GranteePublicKey = granteeFromPrivateKey(`0x${'03'.repeat(32)}`);

interface StoredObject {
  body: Uint8Array;
  history: string;
  publisher: string;
}

export interface FakeSwarmOptions {
  publisher?: GranteePublicKey;
  /** Makes uploads report no history address, as a non-ACT upload would. */
  omitHistoryAddress?: boolean;
  /** Every download fails with this instead of the normal ACT check. */
  downloadError?: Error;
}

export interface RecordedPatch {
  at: number;
  add: readonly string[];
  revoke: readonly string[];
}

export class FakeSwarm {
  readonly objects = new Map<string, StoredObject>();
  readonly patches: RecordedPatch[] = [];
  readonly bee: Bee;

  #counter = 0;
  readonly #options: FakeSwarmOptions;

  constructor(options: FakeSwarmOptions = {}) {
    this.#options = options;
    this.bee = this.#makeBee();
  }

  /** Replaces stored bytes without changing the reference, to fake tampering. */
  overwrite(reference: string, body: Uint8Array): void {
    const stored = this.objects.get(reference);
    if (!stored) throw new Error(`no such fake object: ${reference}`);
    stored.body = body;
  }

  #makeBee(): Bee {
    const swarm = this;
    const publisher = this.#options.publisher ?? PUBLISHER_KEY;

    return {
      data: {
        async upload(_batchId: string, body: Uint8Array, options?: { actHistoryAddress?: string }) {
          const reference = swarm.#nextHex();
          const history = options?.actHistoryAddress ?? swarm.#nextHex();
          swarm.objects.set(reference, { body, history, publisher });

          return {
            reference: hexBytes(reference),
            historyAddress: {
              getOrThrow: () => {
                if (swarm.#options.omitHistoryAddress) throw new Error('history address is absent');
                return hexBytes(history);
              },
            },
          };
        },

        async download(reference: string, options?: { actPublisher?: string; actHistoryAddress?: string }) {
          if (swarm.#options.downloadError) throw swarm.#options.downloadError;

          const stored = swarm.objects.get(reference);
          // Missing content and missing credentials are the same answer, on purpose.
          if (!stored) throw new FakeNotFound();
          if (options?.actPublisher !== stored.publisher) throw new FakeNotFound();
          if (options.actHistoryAddress !== stored.history) throw new FakeNotFound();

          return { toUint8Array: () => stored.body };
        },
      },

      grantee: {
        async create(_batchId: string, grantees: string[]) {
          swarm.patches.push({ at: Date.now(), add: [...grantees], revoke: [] });
          return { ref: hexBytes(swarm.#nextHex()), historyref: hexBytes(swarm.#nextHex()) };
        },

        async patch(
          _batchId: string,
          _reference: string,
          _history: string,
          changes: { add?: string[]; revoke?: string[] },
        ) {
          swarm.patches.push({ at: Date.now(), add: changes.add ?? [], revoke: changes.revoke ?? [] });
          return { ref: hexBytes(swarm.#nextHex()), historyref: hexBytes(swarm.#nextHex()) };
        },

        async get() {
          const last = swarm.patches.at(-1);
          if (!last) throw new FakeNotFound();
          return { grantees: last.add.map((key) => ({ toCompressedHex: () => key })) };
        },
      },
    } as unknown as Bee;
  }

  #nextHex(): string {
    this.#counter += 1;
    return this.#counter.toString(16).padStart(64, '0');
  }
}

function hexBytes(hex: string): { toHex: () => string } {
  return { toHex: () => hex };
}

export function nodeCaps(overrides: Partial<SealCapabilities> = {}): SealCapabilities {
  return {
    kind: 'node',
    url: 'http://localhost:1633',
    canManageGrantees: true,
    canManagePostage: true,
    canUnseal: true,
    usesNullStamp: false,
    confidentiality: 'key-bound',
    limitations: [],
    ...overrides,
  };
}

export function gatewayCaps(overrides: Partial<SealCapabilities> = {}): SealCapabilities {
  return {
    kind: 'gateway',
    url: 'https://api.gateway.ethswarm.org',
    canManageGrantees: false,
    canManagePostage: false,
    canUnseal: false,
    usesNullStamp: true,
    confidentiality: 'obscurity',
    limitations: ['POST /grantee is not exposed here'],
    ...overrides,
  };
}

export function fakeBackend(
  swarm: FakeSwarm,
  caps: SealCapabilities,
  publisher: GranteePublicKey | null = PUBLISHER_KEY,
): SwarmBackend {
  return { bee: swarm.bee, caps, batchId: '0'.repeat(64), publisher };
}
