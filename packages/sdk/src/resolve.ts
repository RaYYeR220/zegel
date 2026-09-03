import {
  bytesToHex,
  decodeAbiParameters,
  encodeFunctionData,
  hexToString,
  namehash,
  parseAbi,
  type Address,
  type Hex,
  type PublicClient,
} from 'viem';
import { packetToBytes } from 'viem/ens';
import { ENVELOPE_SCHEMA, type SealedEnvelope } from './types.js';

/**
 * ENSIP-24 record key the envelope is published under.
 *
 * ENSIP-24 reserves no global keys, so this is namespaced to us the way winning
 * ENS integrations namespace their own (`kondor-policy`, `stealthpay.v1.*`).
 */
export const ENVELOPE_RECORD_KEY = 'zegel.envelope.v1';

/** ENSIP-10 wildcard resolution. */
const EXTENDED_RESOLVER_ABI = parseAbi([
  'function resolve(bytes name, bytes data) view returns (bytes)',
]);

/** ENSIP-24 arbitrary data resolution. */
const DATA_RESOLVER_ABI = parseAbi([
  'function data(bytes32 node, string key) view returns (bytes)',
]);

const SUPPORTS_INTERFACE_ABI = parseAbi([
  'function supportsInterface(bytes4 interfaceId) view returns (bool)',
]);

/** ENSIP-10 `IExtendedResolver`. */
export const EXTENDED_RESOLVER_INTERFACE_ID = '0x9061b923' as const;
/** ENSIP-24 `IDataResolver`. */
export const DATA_RESOLVER_INTERFACE_ID = '0xecbfada3' as const;

export class NoResolverError extends Error {
  constructor(readonly name: string) {
    super(`no resolver set for ${name}`);
    this.name = 'NoResolverError';
  }
}

export class NoEnvelopeError extends Error {
  constructor(readonly name: string) {
    super(`${name} resolves, but publishes no Zegel envelope`);
    this.name = 'NoEnvelopeError';
  }
}

export class MalformedEnvelopeError extends Error {
  constructor(readonly detail: string) {
    super(`envelope is not readable: ${detail}`);
    this.name = 'MalformedEnvelopeError';
  }
}

export interface ResolveOptions {
  /** Defaults to `zegel.envelope.v1`. */
  key?: string;
  /** Skip the wildcard path and call `data()` directly. Useful against a known resolver. */
  resolver?: Address;
}

/**
 * Read the sealed envelope published under an ENS name.
 *
 * Resolution goes through ENSIP-10 `resolve()` where the resolver supports it, so a
 * wildcard resolver can answer for a subname that was never registered on chain. viem
 * follows the ERC-3668 `OffchainLookup` revert itself; nothing here needs to know
 * whether the answer came from storage or from a gateway.
 *
 * The envelope is public by design. It says that a reference exists, when it expires
 * and where the sealed tiers live — never what they contain.
 */
export async function resolveEnvelope(
  client: PublicClient,
  name: string,
  options: ResolveOptions = {},
): Promise<SealedEnvelope> {
  const key = options.key ?? ENVELOPE_RECORD_KEY;
  const node = namehash(name);

  const resolver = options.resolver ?? (await client.getEnsResolver({ name }));
  if (!resolver || resolver === '0x0000000000000000000000000000000000000000') {
    throw new NoResolverError(name);
  }

  const inner = encodeFunctionData({
    abi: DATA_RESOLVER_ABI,
    functionName: 'data',
    args: [node, key],
  });

  const raw = (await supportsInterface(client, resolver, EXTENDED_RESOLVER_INTERFACE_ID))
    ? await resolveWildcard(client, resolver, name, inner)
    : await resolveDirect(client, resolver, node, key);

  if (!raw || raw === '0x') throw new NoEnvelopeError(name);
  return decodeEnvelope(raw);
}

async function resolveWildcard(
  client: PublicClient,
  resolver: Address,
  name: string,
  inner: Hex,
): Promise<Hex> {
  const wrapped = await client.readContract({
    address: resolver,
    abi: EXTENDED_RESOLVER_ABI,
    functionName: 'resolve',
    args: [bytesToHex(packetToBytes(name)), inner],
  });

  // `resolve()` hands back the inner call's return value still ABI-encoded, because
  // CCIP-Read substitutes the callback's return data for the original call. Unwrapping
  // it here is the difference between a working resolver and one that silently returns
  // garbage — the failure mode is a decode error 200 lines away, so do it at the seam.
  if (!wrapped || wrapped === '0x') return '0x';
  const [unwrapped] = decodeAbiParameters([{ type: 'bytes' }], wrapped);
  return unwrapped;
}

async function resolveDirect(
  client: PublicClient,
  resolver: Address,
  node: Hex,
  key: string,
): Promise<Hex> {
  return client.readContract({
    address: resolver,
    abi: DATA_RESOLVER_ABI,
    functionName: 'data',
    args: [node, key],
  });
}

async function supportsInterface(
  client: PublicClient,
  resolver: Address,
  interfaceId: Hex,
): Promise<boolean> {
  try {
    return await client.readContract({
      address: resolver,
      abi: SUPPORTS_INTERFACE_ABI,
      functionName: 'supportsInterface',
      args: [interfaceId],
    });
  } catch {
    // Pre-ENSIP-165 resolvers revert rather than answering false.
    return false;
  }
}

/** Decode and shape-check the bytes a resolver returned. */
export function decodeEnvelope(raw: Hex): SealedEnvelope {
  let text: string;
  try {
    text = hexToString(raw);
  } catch (cause) {
    throw new MalformedEnvelopeError(`not valid hex (${String(cause)})`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new MalformedEnvelopeError('not valid JSON');
  }

  return assertEnvelope(parsed);
}

export function assertEnvelope(value: unknown): SealedEnvelope {
  if (typeof value !== 'object' || value === null) {
    throw new MalformedEnvelopeError('not an object');
  }
  const e = value as Partial<SealedEnvelope>;
  if (e.schema !== ENVELOPE_SCHEMA) {
    throw new MalformedEnvelopeError(`unknown schema ${String(e.schema)}`);
  }
  for (const field of ['referenceId', 'commitment', 'issuedAt', 'expiresAt'] as const) {
    if (typeof e[field] !== 'string') {
      throw new MalformedEnvelopeError(`missing ${field}`);
    }
  }
  if (!Array.isArray(e.tiers) || e.tiers.length === 0) {
    throw new MalformedEnvelopeError('no sealed tiers');
  }
  return e as SealedEnvelope;
}
