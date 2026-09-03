/**
 * The three coordinates an ACT read needs, as distinct types.
 *
 * All three are hex strings of similar length and mixing them up produces a 404
 * rather than an error, which is the single easiest way to lose a day. Branding
 * them means a swapped argument is a compile error instead of a silent miss.
 */

import { SealError } from './errors.js';

declare const refBrand: unique symbol;
declare const historyBrand: unique symbol;

/** A Swarm content reference: 64 hex chars, or 128 when the upload was encrypted. */
export type SwarmReference = string & { readonly [refBrand]: 'swarm-reference' };

/**
 * An ACT history address.
 *
 * 🔴 Losing this is permanent, irrecoverable loss of access to your own data.
 * Swarm has no recovery path: the history trie is what maps a timestamp to the
 * encrypted access key, and without it the content is undecryptable ciphertext
 * that answers every request with 404.
 */
export type HistoryAddress = string & { readonly [historyBrand]: 'act-history-address' };

const REFERENCE_PATTERN = /^[A-Fa-f0-9]{64}(?:[A-Fa-f0-9]{64})?$/;
const HISTORY_PATTERN = /^[A-Fa-f0-9]{64}$/;

export function swarmReference(value: string): SwarmReference {
  const hex = strip0x(value);
  if (!REFERENCE_PATTERN.test(hex)) {
    throw new SealError('invalid-envelope', `not a Swarm reference (expected 64 or 128 hex chars): ${value}`);
  }
  return hex.toLowerCase() as SwarmReference;
}

export function historyAddress(value: string): HistoryAddress {
  const hex = strip0x(value);
  if (!HISTORY_PATTERN.test(hex)) {
    throw new SealError('invalid-envelope', `not an ACT history address (expected 64 hex chars): ${value}`);
  }
  return hex.toLowerCase() as HistoryAddress;
}

export function isSwarmReference(value: unknown): value is SwarmReference {
  return typeof value === 'string' && REFERENCE_PATTERN.test(strip0x(value));
}

export function isHistoryAddress(value: unknown): value is HistoryAddress {
  return typeof value === 'string' && HISTORY_PATTERN.test(strip0x(value));
}

function strip0x(value: string): string {
  const trimmed = value.trim();
  return trimmed.startsWith('0x') || trimmed.startsWith('0X') ? trimmed.slice(2) : trimmed;
}
