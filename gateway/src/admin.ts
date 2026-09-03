import { getAddress, recoverTypedDataAddress, type Address, type Hex, type TypedDataDomain } from 'viem';

import type { GatewayConfig } from './config.ts';
import { parseEnvelope } from './envelope.ts';
import { badRequest, conflict, unauthorized } from './errors.ts';
import type { EnvelopeRecord } from './store/types.ts';

export const PUBLISH_DOMAIN_NAME = 'Zegel Gateway';
export const PUBLISH_DOMAIN_VERSION = '1';

/**
 * The message a name's owner signs to publish.
 *
 * EIP-712 rather than a raw string so a wallet renders the fields instead of a hex
 * blob — the person approving this is deciding what their name says about them, and
 * they should be able to read it.
 *
 * `gateway` is the gateway's own signing address. Without it a publish signed for
 * one operator could be replayed to another, which matters because operators are
 * exactly the parties who see every publish go past.
 */
export const PUBLISH_TYPES = {
  PublishEnvelope: [
    { name: 'node', type: 'bytes32' },
    { name: 'envelopeDigest', type: 'bytes32' },
    { name: 'gateway', type: 'address' },
    { name: 'nonce', type: 'uint64' },
    { name: 'validUntil', type: 'uint64' },
  ],
} as const;

/** An authorisation good for longer than this is a standing permission, not a publish. */
export const MAX_AUTHORISATION_WINDOW_SECONDS = 3600;

export interface PublishRequest {
  readonly node: Hex;
  readonly name: string | null;
  /** Canonical JSON text of the envelope. Served back byte for byte. */
  readonly envelope: string;
  readonly nonce: bigint;
  readonly validUntil: bigint;
  readonly signature: Hex;
}

export function publishDomain(chainId: number): TypedDataDomain {
  return { name: PUBLISH_DOMAIN_NAME, version: PUBLISH_DOMAIN_VERSION, chainId };
}

/**
 * Authorises and stores a publish.
 *
 * The authority is ownership of the ENS name, established the same way ENS itself
 * establishes it, and nothing else. There is no API key because there is nowhere to
 * put one: the resolver's `url()` is public on chain, so any credential a client
 * would need to send is a credential published to the world.
 */
export async function publishEnvelope(
  config: GatewayConfig,
  request: PublishRequest,
): Promise<EnvelopeRecord> {
  const envelope = parseEnvelope(request.envelope);
  const now = BigInt(config.now());

  if (request.validUntil <= now) {
    throw unauthorized(`the publish authorisation expired at ${request.validUntil}; it is now ${now}`);
  }
  if (request.validUntil - now > BigInt(MAX_AUTHORISATION_WINDOW_SECONDS)) {
    throw badRequest(
      `validUntil is more than ${MAX_AUTHORISATION_WINDOW_SECONDS}s away; a publish authorisation is not a standing permission`,
    );
  }
  if (BigInt(envelope.expiresAtSeconds) <= now) {
    throw badRequest(
      `the envelope expired at ${envelope.envelope.expiresAt}; publishing it would produce a name that resolves to nothing`,
    );
  }

  const lastNonce = await config.store.lastNonce(request.node);
  if (request.nonce <= lastNonce) {
    throw conflict(
      `nonce ${request.nonce} is not above the last accepted nonce ${lastNonce} for this name`,
    );
  }

  const owner = await config.owners.ownerOf(request.node);
  if (!owner) {
    throw unauthorized(
      `no owner known for node ${request.node} via the ${config.owners.kind} owner lookup`,
    );
  }

  const message = {
    node: request.node,
    envelopeDigest: envelope.digest,
    gateway: config.signer.address,
    nonce: request.nonce,
    validUntil: request.validUntil,
  } as const;

  const authorised = await verifyPublishSignature(config, owner, message, request.signature);
  if (!authorised) {
    throw unauthorized(`the signature is not from ${owner}, the owner of this name`);
  }

  const record: EnvelopeRecord = {
    node: request.node.toLowerCase() as Hex,
    name: request.name,
    envelope,
    publishedAt: new Date(config.now() * 1000).toISOString(),
    publisher: owner,
    nonce: request.nonce,
  };
  await config.store.put(record);
  return record;
}

/**
 * EOA first, then ERC-1271 when there is a chain to ask.
 *
 * ENS names are commonly held by a Safe, whose "signature" recovers to nothing.
 * Without the contract path those owners simply could not publish.
 */
async function verifyPublishSignature(
  config: GatewayConfig,
  owner: Address,
  message: {
    node: Hex;
    envelopeDigest: Hex;
    gateway: Address;
    nonce: bigint;
    validUntil: bigint;
  },
  signature: Hex,
): Promise<boolean> {
  const typedData = {
    domain: publishDomain(config.chainId),
    types: PUBLISH_TYPES,
    primaryType: 'PublishEnvelope',
    message,
  } as const;

  try {
    const recovered = await recoverTypedDataAddress({ ...typedData, signature });
    if (getAddress(recovered) === getAddress(owner)) return true;
  } catch {
    // Malformed for an EOA. A contract signature is not 65 bytes, so fall through.
  }

  if (!config.client) return false;
  try {
    return await config.client.verifyTypedData({ ...typedData, address: owner, signature });
  } catch {
    return false;
  }
}
