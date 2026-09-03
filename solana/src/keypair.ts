/**
 * Keypair loading.
 *
 * Deliberately the only place in this package that touches the filesystem, and it
 * never has a default path: the signing key is supplied by the operator at the
 * boundary. No key material is bundled, defaulted or written anywhere by this code.
 */

import { readFile } from 'node:fs/promises';
import type { KeyPairSigner } from '@solana/kit';
import { toSigner } from './rpc.ts';

/** Reads the standard Solana CLI keypair file: a JSON array of 64 bytes. */
export async function loadKeypairFile(path: string): Promise<KeyPairSigner> {
  const raw = await readFile(path, 'utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new TypeError(`${path} is not a JSON keypair file`);
  }
  if (!Array.isArray(parsed) || parsed.some((n) => typeof n !== 'number')) {
    throw new TypeError(`${path} must contain a JSON array of byte values`);
  }
  return toSigner(Uint8Array.from(parsed as number[]));
}
