import 'server-only';

import {
  createSealClient,
  coordinatesFromTier,
  decodeEnvelope,
  granteeAddress,
  granteePublicKey,
  historyAddress,
  memoryKeeper,
  swarmReference,
  tryGranteePublicKey,
  type SealClient,
  type SealReceipt,
} from '@zegel/seal';

import { BEE_READER_URL, BEE_URL, POSTAGE_BATCH_ID } from '../config';
import type { GranteeView, ReadOutcome, StoredTier } from '../types';

export class SwarmUnavailableError extends Error {
  constructor(
    readonly url: string,
    cause: unknown,
  ) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = 'SwarmUnavailableError';
  }
}

/**
 * Connects to the publisher node.
 *
 * `kind: 'node'` rather than `'auto'` on purpose. Falling back to the public
 * gateway would produce a client that seals happily and can never grant, revoke
 * or read back — a silent downgrade from access control to obscurity. When the
 * node is not there, the caller is told, and the UI says which capability just
 * went missing.
 */
export async function publisherClient(warnings: string[] = []): Promise<SealClient> {
  try {
    return await createSealClient({
      kind: 'node',
      url: BEE_URL,
      keep: memoryKeeper(),
      ...(POSTAGE_BATCH_ID === undefined ? {} : { batchId: POSTAGE_BATCH_ID }),
      onWarning: (message) => warnings.push(message),
    });
  } catch (cause) {
    throw new SwarmUnavailableError(BEE_URL, cause);
  }
}

/**
 * Rebuilds the receipt a grantee patch needs from what the browser kept.
 *
 * The server holds no state between requests, so the three ACT coordinates and
 * the grantee-list reference make the round trip with every call. Losing the
 * history address is permanent, which is exactly why it lives with the issuer
 * rather than in a process that gets recycled.
 */
export function receiptFrom(
  stored: StoredTier,
  referenceId: string,
  client: SealClient,
): SealReceipt {
  return {
    tier: stored.tier,
    referenceId,
    swarmRef: swarmReference(stored.swarmRef),
    actHistoryAddress: historyAddress(stored.actHistoryAddress),
    actPublisher: granteePublicKey(stored.actPublisher),
    digest: '',
    sealedAt: stored.sealedAt,
    backend: client.caps.kind,
    backendUrl: client.caps.url,
    batchId: client.batchId,
    ...(stored.granteeListRef === undefined
      ? {}
      : { granteeListRef: swarmReference(stored.granteeListRef) }),
    grantees: { applied: [], deferred: [] },
    bytes: stored.bytes,
  };
}

export function storedFrom(receipt: SealReceipt): StoredTier {
  if (receipt.actPublisher === null) {
    throw new Error('the backend never reported an ACT publisher key, so nothing could read this back');
  }
  return {
    tier: receipt.tier,
    swarmRef: receipt.swarmRef,
    actHistoryAddress: receipt.actHistoryAddress,
    actPublisher: receipt.actPublisher,
    ...(receipt.granteeListRef === undefined ? {} : { granteeListRef: receipt.granteeListRef }),
    sealedAt: receipt.sealedAt,
    bytes: receipt.bytes,
  };
}

export function toGranteeViews(keys: readonly string[]): GranteeView[] {
  return keys.map((key) => {
    const parsed = granteePublicKey(key);
    return { publicKey: parsed, address: granteeAddress(parsed) };
  });
}

export function parseGranteeKeys(input: readonly string[]): string[] {
  return input.map((raw) => {
    const key = tryGranteePublicKey(raw.trim());
    if (key === null) {
      throw new Error(
        `"${raw.trim()}" is not a compressed secp256k1 public key. ` +
          'A grantee is 66 hex characters starting 02 or 03 — a public key, not an address: ' +
          'an address is a hash and cannot take part in the key exchange ACT uses.',
      );
    }
    return key;
  });
}

/**
 * An ACT read, made the way a reader actually makes it.
 *
 * Deliberately a bare HTTP request rather than a `SealClient`: a grantee node is
 * an unfunded ultra-light node with no postage batch, so constructing a full
 * client against it would fail on a capability reading does not need. This is the
 * same three headers a `curl` would send, and the upstream status and message are
 * reported verbatim — including the difference between a revoked read and a
 * never-existed one, which is a real side channel and is stated rather than
 * smoothed over.
 */
export async function actRead(
  nodeUrl: string,
  tier: StoredTier,
  options: { withCredentials?: boolean; timeoutMs?: number } = {},
): Promise<ReadOutcome> {
  const withCredentials = options.withCredentials ?? true;
  const coordinates = coordinatesFromTier({
    tier: tier.tier,
    swarmRef: tier.swarmRef,
    actHistoryAddress: tier.actHistoryAddress,
    actPublisher: tier.actPublisher,
  });

  const url = new URL(`/bytes/${coordinates.swarmRef}`, nodeUrl).toString();
  const headers: Record<string, string> = withCredentials
    ? {
        'swarm-act': 'true',
        'swarm-act-publisher': coordinates.actPublisher,
        'swarm-act-history-address': coordinates.actHistoryAddress,
      }
    : {};

  const via = `${withCredentials ? 'with ACT credentials' : 'no credentials at all'} against ${nodeUrl}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 15_000);

  try {
    const response = await fetch(url, { headers, signal: controller.signal, cache: 'no-store' });
    const text = await response.text();

    if (!response.ok) {
      return {
        granted: false,
        status: response.status,
        message: extractMessage(text) ?? `HTTP ${response.status}`,
        via,
      };
    }

    const opened = openPayload(text);
    return {
      granted: true,
      status: response.status,
      bytes: new TextEncoder().encode(text).byteLength,
      payload: opened.payload,
      schema: opened.schema,
      sealed: opened.sealed,
      via,
    };
  } catch (cause) {
    return {
      granted: false,
      status: 0,
      message: cause instanceof Error ? cause.message : String(cause),
      via,
    };
  } finally {
    clearTimeout(timer);
  }
}

/** The reader node stands in for a person you granted. It may simply not be running. */
export async function readerAvailable(): Promise<{ ok: boolean; detail: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 2_000);
  try {
    const response = await fetch(new URL('/health', BEE_READER_URL), {
      signal: controller.signal,
      cache: 'no-store',
    });
    return response.ok
      ? { ok: true, detail: `Bee node at ${BEE_READER_URL} answered HTTP ${response.status}` }
      : { ok: false, detail: `${BEE_READER_URL} answered HTTP ${response.status}` };
  } catch (cause) {
    return {
      ok: false,
      detail: `no Bee node at ${BEE_READER_URL}: ${cause instanceof Error ? cause.message : String(cause)}`,
    };
  } finally {
    clearTimeout(timer);
  }
}

/** Bee reports its errors as `{"code":404,"message":"..."}`. The message is the interesting half. */
function extractMessage(text: string): string | null {
  try {
    const parsed = JSON.parse(text) as { message?: unknown };
    return typeof parsed.message === 'string' ? parsed.message : null;
  } catch {
    return text.trim() === '' ? null : text.trim().slice(0, 200);
  }
}

/**
 * Unwrap what the ACT read returned.
 *
 * The preferred form is a `zegel.seal.v1` envelope, and going through
 * `decodeEnvelope` re-checks the payload digest — bytes swapped underneath the
 * reference fail here rather than three screens later as a puzzling claim
 * mismatch. But an object sealed by an older tool, or by anything else that
 * writes to this ACT history, is a bare payload, and refusing to open it would
 * report a *decryption that worked* as a failure. Access is what the read
 * establishes; the shape of what came back is a separate question and is
 * answered separately.
 */
function openPayload(text: string): { payload: unknown; schema: string | null; sealed: boolean } {
  try {
    const envelope = decodeEnvelope<unknown>(text);
    return { payload: envelope.payload, schema: schemaOf(envelope.payload), sealed: true };
  } catch {
    const parsed = JSON.parse(text) as unknown;
    return { payload: parsed, schema: schemaOf(parsed), sealed: false };
  }
}

function schemaOf(value: unknown): string | null {
  if (typeof value !== 'object' || value === null) return null;
  const schema = (value as { schema?: unknown }).schema;
  return typeof schema === 'string' ? schema : null;
}
