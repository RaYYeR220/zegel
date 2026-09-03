import { secp256k1 } from '@noble/curves/secp256k1';
import { keccak_256 } from '@noble/hashes/sha3';
import { bytesToHex, hexToBytes, utf8ToBytes } from '@noble/hashes/utils';

import { InvalidPublicKeyError } from './errors.js';

/**
 * Grantee identity in Swarm's ACT.
 *
 * A grantee is named by a compressed secp256k1 public key — 33 bytes, 66 hex
 * characters, `02`/`03` prefix. Not an Ethereum address: an address is a hash and
 * cannot be used for the Diffie-Hellman step ACT performs, so the two are not
 * interchangeable no matter how similar they look in a config file.
 */
declare const granteeBrand: unique symbol;
export type GranteePublicKey = string & { readonly [granteeBrand]: 'compressed-secp256k1' };

/** The shape Swarm's `/grantee` endpoint accepts. */
export const COMPRESSED_PUBLIC_KEY_PATTERN = /^[A-Fa-f0-9]{66}$/;

/** Cheap shape check. Says nothing about whether the point is on the curve. */
export function looksLikeCompressedPublicKey(value: unknown): value is string {
  return typeof value === 'string' && COMPRESSED_PUBLIC_KEY_PATTERN.test(value);
}

/**
 * Validates and normalises a grantee key.
 *
 * Accepts an optional `0x` prefix and any casing, and returns lowercase hex with
 * no prefix — the exact form Bee wants. Rejects anything not on the secp256k1
 * curve, because Bee accepts such a key into a grantee list and the grant then
 * silently protects nobody.
 */
export function granteePublicKey(value: string): GranteePublicKey {
  const raw = value.trim();
  const hex = raw.startsWith('0x') || raw.startsWith('0X') ? raw.slice(2) : raw;

  if (!COMPRESSED_PUBLIC_KEY_PATTERN.test(hex)) {
    if (hex.length === 128 || hex.length === 130) {
      throw new InvalidPublicKeyError(raw, 'looks uncompressed — use granteeFromUncompressed');
    }
    if (hex.length === 40) {
      throw new InvalidPublicKeyError(raw, 'looks like an Ethereum address, not a public key');
    }
    throw new InvalidPublicKeyError(raw, `expected 66 hex chars, got ${hex.length}`);
  }

  const normalised = hex.toLowerCase();
  const prefix = normalised.slice(0, 2);
  if (prefix !== '02' && prefix !== '03') {
    throw new InvalidPublicKeyError(raw, `prefix must be 02 or 03, got ${prefix}`);
  }

  try {
    secp256k1.ProjectivePoint.fromHex(normalised).assertValidity();
  } catch (cause) {
    throw new InvalidPublicKeyError(raw, 'point is not on the secp256k1 curve');
  }

  return normalised as GranteePublicKey;
}

/** Non-throwing form, for validating user input in a form field. */
export function tryGranteePublicKey(value: string): GranteePublicKey | null {
  try {
    return granteePublicKey(value);
  } catch {
    return null;
  }
}

/** Type guard usable on unknown input. */
export function isGranteePublicKey(value: unknown): value is GranteePublicKey {
  return typeof value === 'string' && tryGranteePublicKey(value) !== null;
}

/** Compresses a 64-byte (`x||y`) or 65-byte (`04||x||y`) uncompressed key. */
export function granteeFromUncompressed(value: string | Uint8Array): GranteePublicKey {
  const bytes = typeof value === 'string' ? hexToBytes(strip0x(value)) : value;
  const body = bytes.length === 65 && bytes[0] === 0x04 ? bytes.subarray(1) : bytes;

  if (body.length !== 64) {
    throw new InvalidPublicKeyError(
      typeof value === 'string' ? value : bytesToHex(bytes),
      `expected 64 or 65 bytes, got ${bytes.length}`,
    );
  }

  const point = secp256k1.ProjectivePoint.fromHex(`04${bytesToHex(body)}`);
  return granteePublicKey(point.toHex(true));
}

/**
 * Derives a grantee key from a private key.
 *
 * Only useful for keys the caller actually holds — a demo verifier identity, or a
 * node key. A browser wallet will not hand over a private key; use
 * `granteeFromSignedMessage` for that case.
 */
export function granteeFromPrivateKey(privateKey: string | Uint8Array): GranteePublicKey {
  const bytes = typeof privateKey === 'string' ? hexToBytes(strip0x(privateKey)) : privateKey;
  return granteePublicKey(bytesToHex(secp256k1.getPublicKey(bytes, true)));
}

/**
 * Recovers a grantee key from an EIP-191 `personal_sign` signature.
 *
 * This is the practical path for a real wallet: EIP-1193 exposes no public key,
 * but any signature reveals it. The verifier signs one message, and that string
 * is enough to grant them access — which also gives us proof they control the
 * key, unlike a pasted hex blob.
 */
export function granteeFromSignedMessage(message: string, signature: string): GranteePublicKey {
  const sig = hexToBytes(strip0x(signature));
  if (sig.length !== 65) {
    throw new InvalidPublicKeyError(signature, `signature must be 65 bytes, got ${sig.length}`);
  }

  const v = sig[64] as number;
  const recovery = v >= 27 ? v - 27 : v;
  if (recovery !== 0 && recovery !== 1) {
    throw new InvalidPublicKeyError(signature, `unexpected recovery byte ${v}`);
  }

  const digest = eip191Hash(message);
  const point = secp256k1.Signature.fromCompact(sig.subarray(0, 64))
    .addRecoveryBit(recovery)
    .recoverPublicKey(digest);

  return granteePublicKey(point.toHex(true));
}

/** The `personal_sign` digest: keccak256 over the prefixed message. */
export function eip191Hash(message: string): Uint8Array {
  const body = utf8ToBytes(message);
  const prefix = utf8ToBytes(`Ethereum Signed Message:\n${body.length}`);
  const joined = new Uint8Array(prefix.length + body.length);
  joined.set(prefix, 0);
  joined.set(body, prefix.length);
  return keccak_256(joined);
}

/** The Ethereum address a grantee key maps to. For display only — ACT keys on the key. */
export function granteeAddress(key: GranteePublicKey): string {
  const uncompressed = secp256k1.ProjectivePoint.fromHex(key).toRawBytes(false).subarray(1);
  return `0x${bytesToHex(keccak_256(uncompressed).subarray(12))}`;
}

/**
 * Validates a list and drops duplicates, preserving order.
 *
 * A repeated key in a `/grantee` patch is not an error at the API level but wastes
 * one of the ~1 patch/second slots, so it is removed here instead.
 */
export function normaliseGrantees(keys: readonly string[]): GranteePublicKey[] {
  const seen = new Set<string>();
  const out: GranteePublicKey[] = [];
  for (const key of keys) {
    const normalised = granteePublicKey(key);
    if (seen.has(normalised)) continue;
    seen.add(normalised);
    out.push(normalised);
  }
  return out;
}

function strip0x(value: string): string {
  const trimmed = value.trim();
  return trimmed.startsWith('0x') || trimmed.startsWith('0X') ? trimmed.slice(2) : trimmed;
}
