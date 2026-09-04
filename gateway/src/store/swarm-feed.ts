import {
  bytesToHex,
  concatHex,
  getAddress,
  hexToBytes,
  isHex,
  keccak256,
  stringToHex,
  type Address,
  type Hex,
} from 'viem';

import { parseEnvelope, type StoredEnvelope } from '../envelope.ts';
import { GatewayError } from '../errors.ts';

import type { EnvelopeRecord, EnvelopeStore, StoreProbe } from './types.ts';

/** Reads are free and unauthenticated here, so the deployed gateway needs no node. */
export const DEFAULT_BEE_URL = 'https://api.gateway.ethswarm.org';

export const DEFAULT_FEED_CACHE_TTL_SECONDS = 15;

const DEFAULT_TIMEOUT_MS = 5_000;

/** A Swarm reference is 32 bytes; a reference-type feed payload prefixes an 8-byte timestamp. */
const REFERENCE_BYTES = 32;
const TIMESTAMP_BYTES = 8;
const TIMESTAMPED_REFERENCE_BYTES = REFERENCE_BYTES + TIMESTAMP_BYTES;

/**
 * Where an envelope lives, derived from the name alone.
 *
 * ```
 * topic = keccak256( utf8(dataKey) ‖ node )
 * ```
 *
 * `node` is the ENS namehash and `dataKey` is the ENSIP-24 record key, so a second
 * record type under the same name lands on a different feed rather than colliding.
 * Nothing secret goes in: anyone holding the name can recompute the topic, fetch the
 * feed from any Bee node, and check that this gateway is serving what the feed says.
 * That is the point — the gateway is a relay, and a relay you can audit.
 *
 * Worked example: `alice.eth` under `zegel.envelope.v1`
 * `node   = 0x787192fc5378cc32aa956ddfdedbf26b24e8d78e40109add0eea2c1a012c3dec`
 * `topic  = 0xe2bdd8e5a9b5a5cf463ffd8e2e12d8c24adfaaefe5b2bb6750fc6a773f3ca4b5`
 */
export function feedTopic(node: Hex, dataKey: string): Hex {
  return keccak256(concatHex([stringToHex(dataKey), node]));
}

export interface SwarmFeedStoreOptions {
  /** Bee API base. Defaults to the public gateway. */
  readonly beeUrl?: string;
  /** The address whose feed is authoritative for every name this gateway serves. */
  readonly owner: Address;
  readonly dataKey: string;
  readonly cacheTtlSeconds?: number;
  readonly timeoutMs?: number;
  /** Epoch seconds. Injected so cache expiry is testable without sleeping. */
  readonly now?: () => number;
  /** Injected by the tests. */
  readonly fetch?: typeof globalThis.fetch;
}

interface CacheEntry {
  readonly record: EnvelopeRecord | undefined;
  readonly fetchedAt: number;
}

interface Failure {
  readonly at: number;
  readonly detail: string;
}

/**
 * Reads the current envelope for a name from a Swarm feed.
 *
 * A feed is a mutable pointer: an owner plus a topic resolves to the latest update.
 * That makes the whole chain
 *
 * ```
 * ENS name -> this gateway -> Swarm feed (owner + topic from the node) -> envelope
 * ```
 *
 * and it makes this gateway **stateless**. It holds no database, no file and no
 * durable memory; publishing is writing the feed, which happens from the issuer's own
 * Bee node and never touches this process. Redeploy it anywhere, on any number of
 * serverless instances, with nothing to migrate — and a censoring or vanished
 * operator costs you nothing but the relay, because the same feed reads identically
 * from any Bee node in the world.
 *
 * It is still true that this gateway sees only public metadata. The feed carries the
 * envelope; the claims stay sealed under Swarm ACT.
 */
export class SwarmFeedEnvelopeStore implements EnvelopeStore {
  readonly kind = 'swarm-feed';
  readonly writable = false;
  readonly description: string;

  readonly #beeUrl: string;
  readonly #owner: Address;
  readonly #dataKey: string;
  readonly #cacheTtl: number;
  readonly #timeoutMs: number;
  readonly #now: () => number;
  readonly #fetch: typeof globalThis.fetch;

  readonly #cache = new Map<string, CacheEntry>();
  #lastFailure: Failure | undefined;

  constructor(options: SwarmFeedStoreOptions) {
    this.#beeUrl = (options.beeUrl ?? DEFAULT_BEE_URL).replace(/\/+$/u, '');
    this.#owner = getAddress(options.owner);
    this.#dataKey = options.dataKey;
    this.#cacheTtl = options.cacheTtlSeconds ?? DEFAULT_FEED_CACHE_TTL_SECONDS;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#now = options.now ?? (() => Math.floor(Date.now() / 1000));
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.description = `Swarm feed ${this.#owner} via ${this.#beeUrl}, cached ${this.#cacheTtl}s`;
  }

  get owner(): Address {
    return this.#owner;
  }

  topicFor(node: Hex): Hex {
    return feedTopic(node.toLowerCase() as Hex, this.#dataKey);
  }

  /**
   * The current envelope, or `undefined`.
   *
   * `undefined` covers both "no feed here" and "the feed could not be reached", and
   * the caller turns either into the same 404. That collapse is deliberate: the only
   * alternative is signing an answer we could not verify, and a signed response is a
   * bearer token that outlives the moment it was minted. An unreachable upstream is
   * not silent, though — it is recorded and `/health` degrades with the reason.
   */
  async get(node: Hex): Promise<EnvelopeRecord | undefined> {
    const key = node.toLowerCase();
    const cached = this.#cache.get(key);
    if (cached && this.#isFresh(cached)) return cached.record;

    let record: EnvelopeRecord | undefined;
    try {
      record = await this.#read(node.toLowerCase() as Hex);
      this.#lastFailure = undefined;
    } catch (error) {
      this.#lastFailure = {
        at: this.#now(),
        detail: error instanceof Error ? error.message : String(error),
      };
      // A stale-but-unexpired cached envelope is better than nothing while the feed
      // is unreachable: it is the same signed content, and its own expiry still binds.
      if (cached && cached.record && cached.record.envelope.expiresAtSeconds > this.#now()) {
        return cached.record;
      }
      return undefined;
    }

    this.#cache.set(key, { record, fetchedAt: this.#now() });
    return record;
  }

  /** Read-only by construction. Publishing is writing the feed, not calling this gateway. */
  async put(): Promise<void> {
    throw new GatewayError(
      501,
      'this gateway reads from a Swarm feed and holds no state; publish by writing the feed with scripts/write-feed.ts',
    );
  }

  /** A feed cannot be enumerated by design. What is here is what has been asked for. */
  async list(): Promise<readonly EnvelopeRecord[]> {
    const records: EnvelopeRecord[] = [];
    for (const entry of this.#cache.values()) if (entry.record) records.push(entry.record);
    return records;
  }

  /** The feed index is the monotonic counter; nothing local needs to track one. */
  async lastNonce(node: Hex): Promise<bigint> {
    return (await this.get(node))?.nonce ?? 0n;
  }

  async probe(): Promise<StoreProbe> {
    const started = Date.now();
    const cached = this.#cache.size;

    try {
      const response = await this.#fetch(`${this.#beeUrl}/health`, {
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
      const latencyMs = Date.now() - started;
      if (!response.ok) {
        return {
          ok: false,
          detail: `${this.#beeUrl} answered ${response.status} on /health`,
          records: cached,
          latencyMs,
        };
      }

      // Reachable now, but a recent read still failed — say both.
      const recent = this.#recentFailure();
      if (recent) {
        return {
          ok: false,
          detail: `${this.description}; last feed read failed: ${recent.detail}`,
          records: cached,
          latencyMs,
        };
      }
      return { ok: true, detail: this.description, records: cached, latencyMs };
    } catch (error) {
      return {
        ok: false,
        detail: `${this.#beeUrl} is unreachable: ${error instanceof Error ? error.message : String(error)}`,
        records: cached,
        latencyMs: Date.now() - started,
      };
    }
  }

  #isFresh(entry: CacheEntry): boolean {
    const now = this.#now();
    if (now - entry.fetchedAt >= this.#cacheTtl) return false;
    // A cached envelope must never outlive its own expiry, however short the TTL.
    return !entry.record || entry.record.envelope.expiresAtSeconds > now;
  }

  #recentFailure(): Failure | undefined {
    if (!this.#lastFailure) return undefined;
    const age = this.#now() - this.#lastFailure.at;
    return age <= Math.max(this.#cacheTtl, 60) ? this.#lastFailure : undefined;
  }

  async #read(node: Hex): Promise<EnvelopeRecord | undefined> {
    const topic = feedTopic(node, this.#dataKey);
    const url = `${this.#beeUrl}/feeds/${this.#owner.slice(2).toLowerCase()}/${topic.slice(2)}`;

    const response = await this.#fetch(url, { signal: AbortSignal.timeout(this.#timeoutMs) });
    if (response.status === 404) return undefined;
    if (!response.ok) {
      throw new Error(`${url} answered ${response.status} ${response.statusText}`);
    }

    const body = new Uint8Array(await response.arrayBuffer());
    const text = await this.#resolve(body);

    let envelope: StoredEnvelope;
    try {
      envelope = parseEnvelope(text);
    } catch (error) {
      // The feed answered with something that is not an envelope. That is a publishing
      // fault, not an absent name, and it must not read as "nothing published here".
      throw new Error(
        `feed ${topic} holds content that is not a Zegel envelope: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    return {
      node,
      name: null,
      envelope,
      publishedAt: new Date(this.#now() * 1000).toISOString(),
      publisher: this.#owner,
      nonce: readFeedIndex(response.headers.get('swarm-feed-index')),
    };
  }

  /**
   * Follows the pointer when there is one.
   *
   * A feed slot holds 4 KB, so an envelope is uploaded as ordinary Swarm content and
   * the feed stores only its reference. Bee 2.x resolves that server-side and hands
   * back the content directly — but not every version and not every deployment does,
   * so a body that is reference-shaped is followed here rather than assumed away.
   */
  async #resolve(body: Uint8Array): Promise<string> {
    const reference = asReference(body);
    if (!reference) return new TextDecoder().decode(body);

    const url = `${this.#beeUrl}/bytes/${reference}`;
    const response = await this.#fetch(url, { signal: AbortSignal.timeout(this.#timeoutMs) });
    if (!response.ok) {
      throw new Error(`feed points at ${reference}, which answered ${response.status} at ${url}`);
    }
    return response.text();
  }
}

/**
 * A raw 32-byte reference, an 8-byte timestamp followed by one, or its hex text.
 * Anything longer is content, since no valid envelope is 40 bytes.
 */
function asReference(body: Uint8Array): string | null {
  if (body.length === REFERENCE_BYTES) return bytesToHex(body).slice(2);
  if (body.length === TIMESTAMPED_REFERENCE_BYTES) {
    return bytesToHex(body.subarray(TIMESTAMP_BYTES)).slice(2);
  }

  const text = new TextDecoder().decode(body).trim();
  if (/^(0x)?[0-9a-fA-F]{64}$/u.test(text)) return text.replace(/^0x/u, '');
  return null;
}

/** `swarm-feed-index` is a big-endian uint64 in hex. It is the feed's own version counter. */
function readFeedIndex(header: string | null): bigint {
  if (!header) return 0n;
  const hex = header.startsWith('0x') ? header : `0x${header}`;
  if (!isHex(hex) || hexToBytes(hex as Hex).length === 0) return 0n;
  try {
    return BigInt(hex);
  } catch {
    return 0n;
  }
}
