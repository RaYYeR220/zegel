import { encodeFunctionData, toHex, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { namehash, packetToBytes } from 'viem/ens';

import { canonicalize } from '../../packages/sdk/src/canonical.ts';
import { ENVELOPE_SCHEMA, type SealedEnvelope } from '../../packages/sdk/src/types.ts';
import { PUBLISH_TYPES, publishDomain } from '../src/admin.ts';
import { defineConfig, type GatewayConfig, type GatewayConfigInput } from '../src/config.ts';
import { envelopeDigest, parseEnvelope } from '../src/envelope.ts';
import { staticOwners } from '../src/owner.ts';
import { createSigner } from '../src/signing.ts';
import { MemoryEnvelopeStore } from '../src/store/memory.ts';

/** Fixed test keys. Nothing here ever touches a live chain. */
export const GATEWAY_SIGNER_KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d' as const;
export const OWNER_KEY = '0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba' as const;
export const STRANGER_KEY = '0x92db14e403b83dfe3df233f83dfa3a0d7096f21ca9b0d6d6b8d88b2b4ec1564e' as const;

export const RESOLVER: Address = '0x8464135c8F25Da09e49BC8782676a84730C318bC';

export const ALICE = 'alice.eth';
export const BOB = 'bob.eth';
export const ALICE_NODE = namehash(ALICE);
export const BOB_NODE = namehash(BOB);

export const ownerAccount = privateKeyToAccount(OWNER_KEY);
export const strangerAccount = privateKeyToAccount(STRANGER_KEY);
export const gatewaySigner = createSigner(GATEWAY_SIGNER_KEY);

const DATA_ABI = [
  {
    type: 'function',
    name: 'data',
    stateMutability: 'view',
    inputs: [
      { name: 'node', type: 'bytes32' },
      { name: 'key', type: 'string' },
    ],
    outputs: [{ type: 'bytes' }],
  },
] as const;

const RESOLVE_ABI = [
  {
    type: 'function',
    name: 'resolve',
    stateMutability: 'view',
    inputs: [
      { name: 'name', type: 'bytes' },
      { name: 'data', type: 'bytes' },
    ],
    outputs: [{ type: 'bytes' }],
  },
] as const;

export function dnsEncode(name: string): Hex {
  return toHex(packetToBytes(name));
}

/** `data(node, key)` — the calldata `ZegelResolver.data()` puts in its OffchainLookup. */
export function dataCallData(node: Hex, key: string = ENVELOPE_SCHEMA): Hex {
  return encodeFunctionData({ abi: DATA_ABI, functionName: 'data', args: [node, key] });
}

/** `resolve(name, data(node, key))` — the wildcard path's calldata. */
export function resolveCallData(name: string, node: Hex, key: string = ENVELOPE_SCHEMA): Hex {
  return encodeFunctionData({
    abi: RESOLVE_ABI,
    functionName: 'resolve',
    args: [dnsEncode(name), dataCallData(node, key)],
  });
}

export interface EnvelopeOptions {
  referenceId?: Hex;
  issuedAt?: string;
  expiresAt?: string;
}

export function sampleEnvelope(options: EnvelopeOptions = {}): SealedEnvelope {
  return {
    schema: ENVELOPE_SCHEMA,
    referenceId: options.referenceId ?? `0x${'11'.repeat(32)}`,
    commitment: `0x${'22'.repeat(32)}`,
    issuedAt: options.issuedAt ?? '2026-09-01T00:00:00.000Z',
    expiresAt: options.expiresAt ?? '2027-09-01T00:00:00.000Z',
    tiers: [
      {
        tier: 1,
        swarmRef: 'a'.repeat(64),
        actHistoryAddress: 'b'.repeat(64),
        actPublisher: `03${'cd'.repeat(32)}`,
      },
    ],
    anchors: {
      base: {
        chainId: 8453,
        contract: '0x1111111111111111111111111111111111111111',
        txHash: `0x${'33'.repeat(32)}`,
      },
    },
    revocationHint: { contract: '0x1111111111111111111111111111111111111111', chainId: 8453 },
  };
}

export function envelopeText(options: EnvelopeOptions = {}): string {
  return canonicalize(sampleEnvelope(options));
}

export interface TestConfigOptions extends Partial<GatewayConfigInput> {
  /** Epoch seconds. Frozen so expiry behaviour is deterministic. */
  clock?: { seconds: number };
}

export const FIXED_NOW = Math.floor(Date.parse('2026-09-04T12:00:00.000Z') / 1000);

export function makeConfig(options: TestConfigOptions = {}): GatewayConfig {
  const clock = options.clock ?? { seconds: FIXED_NOW };
  return defineConfig({
    signer: options.signer ?? gatewaySigner,
    store: options.store ?? new MemoryEnvelopeStore(),
    owners: options.owners ?? staticOwners([[ALICE_NODE, ownerAccount.address]]),
    resolvers: options.resolvers ?? [RESOLVER],
    chainId: options.chainId ?? 1,
    ...(options.signatureTtlSeconds !== undefined
      ? { signatureTtlSeconds: options.signatureTtlSeconds }
      : {}),
    ...(options.cacheTtlSeconds !== undefined ? { cacheTtlSeconds: options.cacheTtlSeconds } : {}),
    ...(options.envelopeKey !== undefined ? { envelopeKey: options.envelopeKey } : {}),
    ...(options.client !== undefined ? { client: options.client } : {}),
    ...(options.ephemeralSigner !== undefined ? { ephemeralSigner: options.ephemeralSigner } : {}),
    ...(options.warnings !== undefined ? { warnings: options.warnings } : {}),
    now: options.now ?? (() => clock.seconds),
  });
}

/** Seeds the store directly, bypassing the admin route. */
export async function seedEnvelope(
  config: GatewayConfig,
  node: Hex = ALICE_NODE,
  options: EnvelopeOptions = {},
): Promise<void> {
  await config.store.put({
    node: node.toLowerCase() as Hex,
    name: null,
    envelope: parseEnvelope(envelopeText(options)),
    publishedAt: new Date(config.now() * 1000).toISOString(),
    publisher: ownerAccount.address,
    nonce: 1n,
  });
}

export interface PublishBodyOptions {
  node?: Hex;
  name?: string;
  envelope?: string;
  nonce?: bigint;
  validUntil?: bigint;
  signWith?: typeof ownerAccount;
  gateway?: Address;
  chainId?: number;
}

/** Builds the EIP-712-signed body the admin route expects. */
export async function publishBody(
  config: GatewayConfig,
  options: PublishBodyOptions = {},
): Promise<Record<string, unknown>> {
  const node = options.node ?? ALICE_NODE;
  const envelope = options.envelope ?? envelopeText();
  const nonce = options.nonce ?? 1n;
  const validUntil = options.validUntil ?? BigInt(config.now() + 300);
  const account = options.signWith ?? ownerAccount;

  const signature = await account.signTypedData({
    domain: publishDomain(options.chainId ?? config.chainId),
    types: PUBLISH_TYPES,
    primaryType: 'PublishEnvelope',
    message: {
      node,
      // Not parseEnvelope: a test that publishes a deliberately invalid envelope still
      // has to produce a well-formed signature over it.
      envelopeDigest: envelopeDigest(envelope),
      gateway: options.gateway ?? config.signer.address,
      nonce,
      validUntil,
    },
  });

  return {
    node,
    ...(options.name !== undefined ? { name: options.name } : {}),
    envelope,
    nonce: nonce.toString(),
    validUntil: validUntil.toString(),
    signature,
  };
}
