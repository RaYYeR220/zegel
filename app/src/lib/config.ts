/**
 * Every address, endpoint and key this app talks to, in one place.
 *
 * All of it is env-driven with a keyless default, because the deployment
 * contract is that a judge opens the URL with no wallet, no key and no install
 * and the read paths work. A value that only exists in someone's shell is a
 * value the demo does not have.
 */

import type { Address } from 'viem';

const env = (key: string): string | undefined => {
  const value = process.env[key];
  return value === undefined || value.trim() === '' ? undefined : value.trim();
};

/** Keyless public RPCs, tried in order. Two, because a rate-limited demo is a dead demo. */
export const ETH_RPCS = [
  env('ETH_RPC_URL'),
  'https://ethereum-rpc.publicnode.com',
  'https://eth.merkle.io',
].filter((url): url is string => url !== undefined);

export const BASE_RPCS = [
  env('BASE_RPC_URL'),
  'https://mainnet.base.org',
  'https://base-rpc.publicnode.com',
].filter((url): url is string => url !== undefined);

/** `ZegelAnchor`, deployed to Base mainnet 2026-09-04. Verified, no owner, permissionless. */
export const ANCHOR_ADDRESS = (env('NEXT_PUBLIC_ZEGEL_ANCHOR') ??
  '0xbcB85eCdeF23a11D5015b260cC4eDCc0c250f42e') as Address;

export const ANCHOR_CHAIN_ID = 8453;

/** The name the reference is published under. */
export const ZEGEL_NAME = env('NEXT_PUBLIC_ZEGEL_NAME') ?? 'zegel.eth';

/** Publisher node. Holds the ACT private key; only it can grant, revoke or reseal. */
export const BEE_URL = env('ZEGEL_BEE_URL') ?? env('BEE_API_URL') ?? 'http://127.0.0.1:1633';

/**
 * A second Bee node standing in for a grantee.
 *
 * ACT decryption happens inside Bee with the reader's own key — there is no
 * browser implementation — so demonstrating a real grantee read means talking to
 * a real second node. When it is absent the read panel says so rather than
 * simulating the answer.
 */
export const BEE_READER_URL = env('ZEGEL_BEE_READER_URL') ?? 'http://127.0.0.1:1643';

export const SWARM_GATEWAY = env('SWARM_GATEWAY_URL') ?? 'https://api.gateway.ethswarm.org';

/** Optional. Absent means the keyless demo host, which is the documented default. */
export const MOBULA_API_KEY = env('MOBULA_API_KEY');

/** Postage batch bought on Gnosis. Absent means the seal layer finds or buys one. */
export const POSTAGE_BATCH_ID = env('ZEGEL_POSTAGE_BATCH_ID');

/** The worked example. Public data, published by every analytics firm already. */
export const WORKED_EXAMPLE = '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045';
export const WORKED_EXAMPLE_NAME = 'vitalik.eth';

export const EXPLORERS = {
  ethereum: 'https://etherscan.io',
  base: 'https://basescan.org',
} as const;

/**
 * How much of the wallet to pull.
 *
 * Sized to finish inside a serverless function's window rather than to be
 * exhaustive: security lookups cost 10 credits each and dominate both the clock
 * and the budget.
 */
export const COLLECTION = {
  /**
   * Two years. Wide enough that a wallet which closes a position every few months
   * still has a track record, and the same window the command line uses so a
   * reference issued from either surface is directly comparable.
   */
  windowDays: 730,
  maxSecurityLookups: 8,
  concurrency: 4,
  historyLimit: 100,
  positionsLimit: 100,
  tradesLimit: 100,
} as const;

/** Days a freshly issued reference stays valid unless the issuer says otherwise. */
export const DEFAULT_EXPIRY_DAYS = 30;
