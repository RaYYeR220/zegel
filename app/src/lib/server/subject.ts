import 'server-only';

import { getAddress, isAddress } from 'viem';
import { normalize } from 'viem/ens';

import { ethClient } from '../chain';
import type { Subject } from '../types';

/** Base58, 32-44 characters — a Solana address, which Mobula also indexes. */
const SOLANA_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export class SubjectError extends Error {
  constructor(
    message: string,
    readonly hint: string,
  ) {
    super(message);
    this.name = 'SubjectError';
  }
}

/**
 * Turn what somebody typed into an address to scan.
 *
 * The ENSIP-15 normalisation is one line and it is the line that stops a
 * homograph lookalike resolving to a different person's wallet. A name that
 * resolves to nothing is an error, never a quiet fallback to treating the name
 * as an address — the scan that followed would be of a wallet nobody asked about.
 */
export async function resolveSubject(input: string): Promise<Subject> {
  const trimmed = input.trim();

  if (isAddress(trimmed)) {
    return { address: getAddress(trimmed), ensName: null, via: 'literal' };
  }

  if (!trimmed.includes('.') || trimmed.startsWith('0x')) {
    if (SOLANA_ADDRESS.test(trimmed)) {
      return { address: trimmed, ensName: null, via: 'literal' };
    }
    throw new SubjectError(
      `"${trimmed}" is neither an address nor an ENS name`,
      'An address is 0x followed by 40 hex characters. A name contains a dot, like vitalik.eth.',
    );
  }

  let name: string;
  try {
    name = normalize(trimmed);
  } catch {
    throw new SubjectError(
      `"${trimmed}" is not a valid ENS name under ENSIP-15`,
      'Normalisation rejected it. Confusable or disallowed characters are refused rather than guessed at.',
    );
  }

  let resolved: string | null;
  try {
    resolved = await ethClient().getEnsAddress({ name });
  } catch (cause) {
    throw new SubjectError(
      `the Ethereum RPC did not answer: ${cause instanceof Error ? cause.message : String(cause)}`,
      'Set ETH_RPC_URL to an endpoint you trust, or paste the address directly.',
    );
  }

  if (resolved === null) {
    throw new SubjectError(
      `${name} does not resolve to an address`,
      'The name may be unregistered, expired, or simply have no address record set.',
    );
  }

  return { address: getAddress(resolved), ensName: name, via: 'ens' };
}

/** The reverse direction, used only to label a scanned address. Never trusted for identity. */
export async function primaryName(address: string): Promise<string | null> {
  if (!isAddress(address)) return null;
  try {
    return await ethClient().getEnsName({ address: getAddress(address) });
  } catch {
    return null;
  }
}
