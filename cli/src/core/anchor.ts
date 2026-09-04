/**
 * The on-chain commitment anchor.
 *
 * `ZegelAnchor` on Base mainnet is what makes revocation observable without
 * decrypting anything, and what makes "these are not the claims that were sealed"
 * a fact a stranger can check rather than a promise we make. Reading it needs no
 * key, no wallet and no funded account, so it stays on the zero-credential path
 * and is therefore consulted by default.
 *
 * The contract is the authority on expiry and revocation; this module only asks
 * it and reports the answer. When it cannot be reached the answer is `null` —
 * never an assumption, and never a pass.
 */

import {
  createPublicClient,
  encodeFunctionData,
  fallback,
  http,
  type Address,
  type Hex,
  type PublicClient,
} from 'viem';
import { base } from 'viem/chains';

import { ANCHOR_STATUS, ZEGEL_ANCHOR_ABI } from '@zegel/sdk';

import type { AnchorOutcome } from './status.js';
import type { ProbeResult } from './probes.js';

/** Deployed 2026-09-03, tx `0x7c32343d…d87d`, block 50,843,365. */
export const ZEGEL_ANCHOR_ADDRESS = '0xbcB85eCdeF23a11D5015b260cC4eDCc0c250f42e';
export const ZEGEL_ANCHOR_CHAIN_ID = 8453;
export const ZEGEL_ANCHOR_DEPLOY_TX =
  '0x7c32343d11f3c74dd4d22f48ad15172d80396aabc9e8808666fa3803a2f5d87d';

/**
 * A reference that is really anchored on mainnet, used as a live test vector.
 *
 * Not demo data: nothing here is asserted, it is only addressed. Every value is
 * read back from the chain at the moment a test or a probe runs, and the whole
 * point of carrying it is that the negative control becomes something anyone can
 * reproduce against a contract they do not have to trust us about.
 */
export const ANCHORED_TEST_VECTOR = {
  referenceId: '0x644e1b8b170a18d7793dc3d266ecab544e3b9d9dca3619e7e8f2a678de4c30ce',
  commitment: '0xe2fb17f0870b418e2799338e1ef8781aff3b6a2d9ef318ec20a7e788dd86c574',
  issuer: '0x7C7625c81D933fA006bBd3eE2601C8eA8251a14B',
  anchorTx: '0xe35a44bd37ee922d719728dcc24e1e046dc98663bf406b9bb722202188d243b6',
} as const;

/**
 * Keyless Base RPCs, in the order they are tried.
 *
 * `mainnet.base.org` first because it is the chain's own endpoint; the second is
 * there so a rate-limited first choice does not take the anchor check down with
 * it during a demo.
 */
export const BASE_RPCS = ['https://mainnet.base.org', 'https://base-rpc.publicnode.com'] as const;
export const DEFAULT_BASE_RPC = BASE_RPCS[0];

/** `ZEGEL_BASE_RPC` wins; `BASE_RPC_URL` is accepted for symmetry with `ETH_RPC_URL`. */
export function baseRpcFromEnv(
  env: Record<string, string | undefined> = process.env,
): string | undefined {
  const configured = env['ZEGEL_BASE_RPC'] ?? env['BASE_RPC_URL'];
  return configured === undefined || configured === '' ? undefined : configured;
}

export function anchorAddressFromEnv(
  env: Record<string, string | undefined> = process.env,
): string {
  const configured = env['ZEGEL_ANCHOR_ADDRESS'];
  return configured === undefined || configured === '' ? ZEGEL_ANCHOR_ADDRESS : configured;
}

const TRANSPORT = { timeout: 12_000, retryCount: 1 } as const;

/**
 * A Base client with bounded patience.
 *
 * A named URL is used alone: if the operator chose an endpoint, quietly asking a
 * different one behind their back would make the answer untraceable.
 */
export function baseClient(rpcUrl?: string): PublicClient {
  return createPublicClient({
    chain: base,
    transport:
      rpcUrl === undefined
        ? fallback(BASE_RPCS.map((url) => http(url, TRANSPORT)))
        : http(rpcUrl, TRANSPORT),
  }) as PublicClient;
}

export interface AnchorReading {
  status: AnchorOutcome;
  /** Raw status index the contract returned, so an unknown enum value is visible. */
  code: number;
  issuer?: string;
  expiresAt?: string;
  anchoredAt?: string;
  revokedAt?: string;
}

/**
 * Ask the contract about one reference and one commitment.
 *
 * Throws when the chain cannot be reached — the caller turns that into "not
 * checked", which is a different thing from any answer the contract could give.
 */
export async function readAnchor(
  referenceId: string,
  commitment: string,
  options: { rpcUrl?: string | undefined; address?: string | undefined } = {},
): Promise<AnchorReading> {
  const client = baseClient(options.rpcUrl);
  const address = (options.address ?? anchorAddressFromEnv()) as Address;

  const code = Number(
    await client.readContract({
      address,
      abi: ZEGEL_ANCHOR_ABI,
      functionName: 'verify',
      args: [referenceId as Hex, commitment as Hex],
    }),
  );

  // The record is a courtesy, not a verdict: a node that answers `verify` but
  // trips over the struct return must not turn a real answer into a failure.
  const record = await client
    .readContract({
      address,
      abi: ZEGEL_ANCHOR_ABI,
      functionName: 'getAnchor',
      args: [referenceId as Hex],
    })
    .catch(() => undefined);

  const reading: AnchorReading = {
    status: ANCHOR_STATUS[code] ?? 'never-anchored',
    code,
  };
  if (record !== undefined) {
    const r = record as { issuer: string; expiresAt: bigint; anchoredAt: bigint; revokedAt: bigint };
    if (r.issuer !== '0x0000000000000000000000000000000000000000') reading.issuer = r.issuer;
    if (r.expiresAt > 0n) reading.expiresAt = isoFromSeconds(r.expiresAt);
    if (r.anchoredAt > 0n) reading.anchoredAt = isoFromSeconds(r.anchoredAt);
    if (r.revokedAt > 0n) reading.revokedAt = isoFromSeconds(r.revokedAt);
  }
  return reading;
}

function isoFromSeconds(seconds: bigint): string {
  return new Date(Number(seconds) * 1000).toISOString();
}

/** One line of context under the anchor verdict, when the contract gave us any. */
export function anchorNote(reading: AnchorReading): string | undefined {
  const parts: string[] = [];
  if (reading.issuer !== undefined) parts.push(`issuer ${reading.issuer}`);
  if (reading.revokedAt !== undefined) parts.push(`revoked ${reading.revokedAt}`);
  else if (reading.expiresAt !== undefined) parts.push(`expires ${reading.expiresAt}`);
  return parts.length === 0 ? undefined : parts.join(', ');
}

/** Calldata for `verify(bytes32,bytes32)`, derived from the shared ABI rather than pasted. */
export function verifyCallData(referenceId: string, commitment: string): Hex {
  return encodeFunctionData({
    abi: ZEGEL_ANCHOR_ABI,
    functionName: 'verify',
    args: [referenceId as Hex, commitment as Hex],
  });
}

/**
 * The `doctor` row for the anchor.
 *
 * It asks the contract about a reference that is genuinely anchored, so a green
 * tick here means the chain answered and the enum decoded — not merely that a
 * TCP connection opened. A status other than `valid` is reported as degraded
 * rather than as failure: the contract is plainly reachable, and the test vector
 * being revoked or expired one day is a fact about the vector, not about Base.
 */
export async function probeAnchor(
  options: { rpcUrl?: string | undefined; address?: string | undefined } = {},
): Promise<ProbeResult> {
  // Left undefined on purpose when nothing is configured: `readAnchor` then uses
  // the whole fallback list, so a single rate-limited endpoint cannot turn a live
  // contract into a red row.
  const rpcUrl = options.rpcUrl ?? baseRpcFromEnv();
  const shown = rpcUrl ?? BASE_RPCS.join(' or ');
  const address = options.address ?? anchorAddressFromEnv();
  const started = Date.now();

  try {
    const reading = await readAnchor(
      ANCHORED_TEST_VECTOR.referenceId,
      ANCHORED_TEST_VECTOR.commitment,
      { rpcUrl, address },
    );
    const ok = reading.status === 'valid';
    return {
      id: 'anchor-base',
      name: 'ZegelAnchor on Base (revocation check)',
      endpoint: `${shown} -> ${address}`,
      status: ok ? 'ok' : 'degraded',
      detail: `verify() returned ${reading.code} (${reading.status}) for the anchored test reference`,
      cost: ok
        ? ''
        : 'the contract answers, but the reference this probe uses is no longer valid; verify still works, and will report exactly this status',
      latencyMs: Date.now() - started,
    };
  } catch (cause) {
    return {
      id: 'anchor-base',
      name: 'ZegelAnchor on Base (revocation check)',
      endpoint: `${shown} -> ${address}`,
      status: 'unavailable',
      detail: cause instanceof Error ? cause.message.split('\n')[0] ?? 'read failed' : String(cause),
      cost: 'verify cannot consult the anchor, so revocation cannot be ruled out; it will say so rather than returning valid',
      latencyMs: Date.now() - started,
    };
  }
}
