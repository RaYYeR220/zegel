import type { NotGranted, Unsealed } from '../../sdk/src/types.js';

import { connectBackend, type ConnectBackendOptions, type SealCapabilities, type SwarmBackend } from './backend.js';
import { encodeEnvelopeObject, makeEnvelope, decodeEnvelope, type SealEnvelope, type SealTierNumber } from './envelope.js';
import { GranteeManagementUnavailableError, PublisherUnknownError, SealError, isNotFound } from './errors.js';
import type { ReceiptKeeper } from './keeper.js';
import { normaliseGrantees, type GranteePublicKey } from './pubkey.js';
import { PatchQueue, type DepthListener, type PatchQueueOptions } from './queue.js';
import type { GranteeOutcome, SealCoordinates, SealReceipt } from './receipt.js';
import { historyAddress, swarmReference, type HistoryAddress, type SwarmReference } from './refs.js';

/**
 * Swarm answers an un-granted read with 404, which is byte-identical to the answer
 * for content that never existed. That indistinguishability is the privacy
 * property, so it is returned as a value the caller must handle rather than thrown.
 */
const NOT_GRANTED: NotGranted = Object.freeze({ granted: false, reason: 'not-granted-or-absent' });

export interface SealClientOptions extends ConnectBackendOptions {
  /**
   * Where seal receipts are persisted. Required, not optional.
   *
   * The ACT history address cannot be recovered from Swarm, from the reference, or
   * from the publisher key. If it is not written down at the moment of sealing it
   * is gone, and the content with it.
   */
  keep: ReceiptKeeper;
  /** Tuning for the grantee-patch rate floor. The default is the one Bee needs. */
  queue?: PatchQueueOptions;
  /** Non-fatal degradations are reported here rather than swallowed. */
  onWarning?: (message: string) => void;
}

export interface SealOptions {
  referenceId: string;
  tier?: SealTierNumber;
  /** Overrides the sealing timestamp. Only for reproducible tests. */
  sealedAt?: string;
  /**
   * What to do when grantees were requested but the backend cannot manage them.
   * Default `throw`: a caller who asked to grant access must never believe it happened.
   */
  whenGranteesUnsupported?: 'throw' | 'defer';
}

export interface UnsealOptions {
  /**
   * Selects a historical ACT version.
   *
   * This is the mechanism behind forward-only revocation: a grantee who knows the
   * timestamp they were granted at can still read that version after being
   * revoked. It is exposed because pretending otherwise would be a lie.
   */
  actTimestamp?: number | string;
  timeoutMs?: number;
}

export interface GranteeListReceipt {
  /** New grantee-list reference. Supersedes the previous one for later patches. */
  readonly granteeListRef: SwarmReference;
  /** New history address. Readers must be given this to see the current version. */
  readonly actHistoryAddress: HistoryAddress;
  readonly added: readonly GranteePublicKey[];
  readonly revoked: readonly GranteePublicKey[];
  readonly at: string;
  /**
   * True after a revoke. The removed keys keep every version sealed before this
   * patch and can still fetch those by timestamp; only content re-sealed under the
   * new history is closed to them. See `reseal`.
   */
  readonly rotationRequired: boolean;
}

/**
 * The sealing layer.
 *
 * One interface over two backends. The public gateway seals with no node, no
 * postage and no tokens; a Bee node we run adds grantee management, real postage
 * and genuine key-bound confidentiality. The difference is reported through
 * `caps`, never hidden.
 */
export class SealClient {
  readonly #backend: SwarmBackend;
  readonly #keep: ReceiptKeeper;
  readonly #queue: PatchQueue;
  readonly #warn: (message: string) => void;

  constructor(backend: SwarmBackend, options: SealClientOptions) {
    this.#backend = backend;
    this.#keep = options.keep;
    this.#queue = new PatchQueue(options.queue);
    this.#warn = options.onWarning ?? (() => undefined);
  }

  get caps(): SealCapabilities {
    return this.#backend.caps;
  }

  /** ACT publisher key, or null when this backend does not expose one. */
  get publisher(): GranteePublicKey | null {
    return this.#backend.publisher;
  }

  get batchId(): string {
    return this.#backend.batchId;
  }

  /** Grantee patches queued but not yet applied. A UI renders this as pending work. */
  get pendingPatches(): number {
    return this.#queue.depth;
  }

  /** Milliseconds before the next patch may be issued. */
  get nextPatchInMs(): number {
    return this.#queue.waitMs;
  }

  onQueueDepthChange(listener: DepthListener): () => void {
    return this.#queue.onDepthChange(listener);
  }

  /** Resolves once every queued grantee patch has settled. */
  async drainPatches(): Promise<void> {
    await this.#queue.drain();
  }

  /**
   * Seals a payload under ACT and returns the coordinates needed to read it back.
   *
   * The receipt is handed to the client's keeper and awaited before this resolves,
   * so by the time the caller sees a reference the history address is already
   * durable.
   */
  async seal<T>(
    payload: T,
    granteePubKeys: readonly string[] = [],
    options: SealOptions,
  ): Promise<SealReceipt> {
    const requested = normaliseGrantees(granteePubKeys);
    const tier = options.tier ?? 1;

    const { granteeListRef, granteeHistory, outcome } = await this.#prepareGranteeList(
      requested,
      options.whenGranteesUnsupported ?? 'throw',
    );

    const envelope = makeEnvelope({
      tier,
      referenceId: options.referenceId,
      payload,
      ...(options.sealedAt ? { sealedAt: options.sealedAt } : {}),
    });
    const body = encodeEnvelopeObject(envelope);

    const uploaded = await this.#backend.bee.data.upload(this.#backend.batchId, body, {
      act: true,
      ...(granteeHistory ? { actHistoryAddress: granteeHistory } : {}),
    });

    // bee-js models the history address as an Optional. If ACT was requested and it
    // came back absent, the upload was not access-controlled and the bytes are public.
    let history: string;
    try {
      history = uploaded.historyAddress.getOrThrow().toHex();
    } catch (cause) {
      throw new SealError(
        'invalid-envelope',
        'the upload returned no ACT history address, so the content is not access-controlled — refusing to report it as sealed',
        { cause },
      );
    }

    const publisher = this.#backend.publisher;
    if (!publisher) {
      this.#warn(
        `sealed to ${this.caps.url}, but that endpoint does not expose its public key: the ACT publisher ` +
          `is unknown, so this object cannot be read back or published in an envelope until one is configured`,
      );
    }

    const receipt: SealReceipt = {
      tier,
      referenceId: options.referenceId,
      swarmRef: swarmReference(uploaded.reference.toHex()),
      actHistoryAddress: historyAddress(history),
      actPublisher: publisher,
      digest: envelope.digest,
      sealedAt: envelope.sealedAt,
      backend: this.caps.kind,
      backendUrl: this.caps.url,
      batchId: this.#backend.batchId,
      ...(granteeListRef ? { granteeListRef } : {}),
      grantees: outcome,
      bytes: body.byteLength,
    };

    await this.#keep(receipt);
    return receipt;
  }

  /**
   * Writes the payload again under the current grantee list.
   *
   * Needed after a revoke: patching the list changes who can open *future*
   * versions, and the live content only becomes unreadable to a removed key once
   * it is written again under the post-patch history.
   */
  async reseal<T>(
    previous: SealReceipt,
    payload: T,
    options?: { sealedAt?: string; actHistoryAddress?: HistoryAddress },
  ): Promise<SealReceipt> {
    const envelope = makeEnvelope({
      tier: previous.tier,
      referenceId: previous.referenceId,
      payload,
      ...(options?.sealedAt ? { sealedAt: options.sealedAt } : {}),
    });
    const body = encodeEnvelopeObject(envelope);

    const uploaded = await this.#backend.bee.data.upload(this.#backend.batchId, body, {
      act: true,
      actHistoryAddress: options?.actHistoryAddress ?? previous.actHistoryAddress,
    });

    const receipt: SealReceipt = {
      ...previous,
      swarmRef: swarmReference(uploaded.reference.toHex()),
      actHistoryAddress: historyAddress(uploaded.historyAddress.getOrThrow().toHex()),
      digest: envelope.digest,
      sealedAt: envelope.sealedAt,
      bytes: body.byteLength,
    };

    await this.#keep(receipt);
    return receipt;
  }

  /**
   * Reads a sealed object.
   *
   * A caller with no grant gets `NotGranted`, never an exception. Everything else —
   * a malformed envelope, an unreachable node, an unknown publisher — throws,
   * because those are faults rather than answers.
   */
  async unseal<T>(coordinates: SealCoordinates, options: UnsealOptions = {}): Promise<Unsealed<T>> {
    const result = await this.unsealEnvelope<T>(coordinates, options);
    return result.granted ? { granted: true, payload: result.envelope.payload } : result;
  }

  /** As `unseal`, but hands back the whole envelope rather than only the payload. */
  async unsealEnvelope<T>(
    coordinates: SealCoordinates,
    options: UnsealOptions = {},
  ): Promise<{ granted: true; envelope: SealEnvelope<T> } | NotGranted> {
    if (!coordinates.actPublisher) throw new PublisherUnknownError(this.caps.url);

    try {
      const downloaded = await this.#backend.bee.data.download(coordinates.swarmRef, {
        actPublisher: coordinates.actPublisher,
        actHistoryAddress: coordinates.actHistoryAddress,
        ...(options.actTimestamp !== undefined ? { actTimestamp: options.actTimestamp } : {}),
        ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
      });
      return { granted: true, envelope: decodeEnvelope<T>(downloaded.toUint8Array()) };
    } catch (cause) {
      if (isNotFound(cause)) return NOT_GRANTED;
      throw cause;
    }
  }

  /** Adds keys to the grantee list. Queued behind the rate floor. */
  async grant(receipt: SealReceipt, granteePubKeys: readonly string[]): Promise<GranteeListReceipt> {
    return this.#patch(receipt, { add: normaliseGrantees(granteePubKeys), revoke: [] });
  }

  /**
   * Removes keys from the grantee list.
   *
   * Forward-only. A removed key keeps every version it could already read, and can
   * still fetch those by supplying the timestamp it was granted at. To close the
   * live content to it, follow with `reseal`.
   */
  async revoke(receipt: SealReceipt, granteePubKeys: readonly string[]): Promise<GranteeListReceipt> {
    return this.#patch(receipt, { add: [], revoke: normaliseGrantees(granteePubKeys) });
  }

  /** One patch that both adds and removes, spending a single rate-floor slot. */
  async patchGrantees(
    receipt: SealReceipt,
    changes: { add?: readonly string[]; revoke?: readonly string[] },
  ): Promise<GranteeListReceipt> {
    return this.#patch(receipt, {
      add: normaliseGrantees(changes.add ?? []),
      revoke: normaliseGrantees(changes.revoke ?? []),
    });
  }

  /**
   * The current grantee list.
   *
   * Only the publisher can decrypt it; anyone else gets 404, which is returned as
   * `null` rather than thrown.
   */
  async listGrantees(receipt: SealReceipt): Promise<GranteePublicKey[] | null> {
    this.#requireGranteeManagement();

    const reference = receipt.granteeListRef ?? receipt.swarmRef;
    try {
      const result = await this.#backend.bee.grantee.get(reference);
      return result.grantees.map((key) => key.toCompressedHex() as GranteePublicKey);
    } catch (cause) {
      if (isNotFound(cause)) return null;
      throw cause;
    }
  }

  async #patch(
    receipt: SealReceipt,
    changes: { add: readonly GranteePublicKey[]; revoke: readonly GranteePublicKey[] },
  ): Promise<GranteeListReceipt> {
    this.#requireGranteeManagement();

    const reference = receipt.granteeListRef;
    if (!reference) {
      throw new SealError(
        'grantee-management-unavailable',
        'this receipt carries no grantee list to patch — seal with at least one grantee so a list exists',
      );
    }

    return this.#queue.enqueue(async () => {
      const result = await this.#backend.bee.grantee.patch(
        this.#backend.batchId,
        reference,
        receipt.actHistoryAddress,
        {
          ...(changes.add.length > 0 ? { add: [...changes.add] } : {}),
          ...(changes.revoke.length > 0 ? { revoke: [...changes.revoke] } : {}),
        },
      );

      return {
        granteeListRef: swarmReference(result.ref.toHex()),
        actHistoryAddress: historyAddress(result.historyref.toHex()),
        added: changes.add,
        revoked: changes.revoke,
        at: new Date().toISOString(),
        rotationRequired: changes.revoke.length > 0,
      };
    });
  }

  async #prepareGranteeList(
    requested: readonly GranteePublicKey[],
    onUnsupported: 'throw' | 'defer',
  ): Promise<{
    granteeListRef: SwarmReference | undefined;
    granteeHistory: string | undefined;
    outcome: GranteeOutcome;
  }> {
    if (requested.length === 0) {
      return { granteeListRef: undefined, granteeHistory: undefined, outcome: { applied: [], deferred: [] } };
    }

    if (!this.caps.canManageGrantees) {
      if (onUnsupported === 'throw') throw new GranteeManagementUnavailableError(this.caps.url);

      const reason =
        `${this.caps.url} does not expose /grantee: the object was sealed to the publisher only and ` +
        `${requested.length} requested grantee(s) were NOT granted access`;
      this.#warn(reason);
      return {
        granteeListRef: undefined,
        granteeHistory: undefined,
        outcome: { applied: [], deferred: requested, reason },
      };
    }

    const created = await this.#queue.enqueue(() =>
      this.#backend.bee.grantee.create(this.#backend.batchId, [...requested]),
    );

    return {
      granteeListRef: swarmReference(created.ref.toHex()),
      granteeHistory: created.historyref.toHex(),
      outcome: { applied: requested, deferred: [] },
    };
  }

  #requireGranteeManagement(): void {
    if (!this.caps.canManageGrantees) throw new GranteeManagementUnavailableError(this.caps.url);
  }
}

/**
 * Connects to Swarm and returns a ready client.
 *
 * Async because the backend is probed rather than assumed: whether a node exists
 * decides whether grant and revoke exist at all, and a client that has not asked
 * cannot report `caps` honestly.
 */
export async function createSealClient(options: SealClientOptions): Promise<SealClient> {
  const backend = await connectBackend(options);
  return new SealClient(backend, options);
}
