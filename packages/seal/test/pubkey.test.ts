import { secp256k1 } from '@noble/curves/secp256k1';
import { bytesToHex } from '@noble/hashes/utils';
import { describe, expect, it } from 'vitest';
import { privateKeyToAccount } from 'viem/accounts';
import { recoverPublicKey, toBytes } from 'viem';

import { InvalidPublicKeyError } from '../src/errors.js';
import {
  COMPRESSED_PUBLIC_KEY_PATTERN,
  eip191Hash,
  granteeAddress,
  granteeFromPrivateKey,
  granteeFromSignedMessage,
  granteeFromUncompressed,
  granteePublicKey,
  isGranteePublicKey,
  normaliseGrantees,
  tryGranteePublicKey,
} from '../src/pubkey.js';

const PRIVATE_KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d' as const;
const COMPRESSED = bytesToHex(secp256k1.getPublicKey(PRIVATE_KEY.slice(2), true));

describe('grantee public keys', () => {
  it('accepts the shape Swarm documents', () => {
    const key = '02ab7473879005929d10ce7d4f626412dad9fe56b0a6622038931d26bd79abf0a4';
    expect(COMPRESSED_PUBLIC_KEY_PATTERN.test(key)).toBe(true);
    expect(granteePublicKey(key)).toBe(key);
  });

  it('normalises casing and a 0x prefix to what Bee expects', () => {
    const upper = `0X${COMPRESSED.toUpperCase()}`;
    expect(granteePublicKey(upper)).toBe(COMPRESSED);
  });

  it('rejects an Ethereum address with a message naming the confusion', () => {
    expect(() => granteePublicKey('0x7C7625c81D933fA006bBd3eE2601C8eA8251a14B')).toThrowError(
      /Ethereum address/,
    );
  });

  it('rejects an uncompressed key and points at the right helper', () => {
    const uncompressed = bytesToHex(secp256k1.getPublicKey(PRIVATE_KEY.slice(2), false));
    expect(() => granteePublicKey(uncompressed)).toThrowError(/granteeFromUncompressed/);
  });

  it('rejects 66 hex chars that are not on the curve', () => {
    const offCurve = `02${'ff'.repeat(32)}`;
    expect(COMPRESSED_PUBLIC_KEY_PATTERN.test(offCurve)).toBe(true);
    expect(() => granteePublicKey(offCurve)).toThrowError(InvalidPublicKeyError);
    expect(() => granteePublicKey(offCurve)).toThrowError(/not on the secp256k1 curve/);
  });

  it('rejects a valid point carrying an uncompressed prefix', () => {
    expect(() => granteePublicKey(`04${COMPRESSED.slice(2)}`)).toThrowError(/prefix must be 02 or 03/);
  });

  it('reports invalid input without throwing when asked not to', () => {
    expect(tryGranteePublicKey('nonsense')).toBeNull();
    expect(tryGranteePublicKey(COMPRESSED)).toBe(COMPRESSED);
    expect(isGranteePublicKey(COMPRESSED)).toBe(true);
    expect(isGranteePublicKey(42)).toBe(false);
  });

  it('derives a grantee key from a private key', () => {
    expect(granteeFromPrivateKey(PRIVATE_KEY)).toBe(COMPRESSED);
  });

  it('compresses both 64- and 65-byte uncompressed keys to the same value', () => {
    const uncompressed = bytesToHex(secp256k1.getPublicKey(PRIVATE_KEY.slice(2), false));
    expect(granteeFromUncompressed(uncompressed)).toBe(COMPRESSED);
    expect(granteeFromUncompressed(uncompressed.slice(2))).toBe(COMPRESSED);
  });

  it('recovers a grantee key from a wallet signature, matching viem', async () => {
    const account = privateKeyToAccount(PRIVATE_KEY);
    const message = 'zegel: grant me a reference';
    const signature = await account.signMessage({ message });

    expect(granteeFromSignedMessage(message, signature)).toBe(COMPRESSED);

    const viemRecovered = await recoverPublicKey({ hash: `0x${bytesToHex(eip191Hash(message))}`, signature });
    expect(bytesToHex(secp256k1.ProjectivePoint.fromHex(viemRecovered.slice(2)).toRawBytes(true))).toBe(
      COMPRESSED,
    );
  });

  it('rejects a signature of the wrong length', () => {
    expect(() => granteeFromSignedMessage('x', '0xdeadbeef')).toThrowError(/65 bytes/);
  });

  it('derives the same address viem does, for display', () => {
    const account = privateKeyToAccount(PRIVATE_KEY);
    expect(granteeAddress(granteePublicKey(COMPRESSED)).toLowerCase()).toBe(account.address.toLowerCase());
    expect(toBytes(account.address)).toHaveLength(20);
  });

  it('drops duplicates so a repeated key does not waste a rate-limited patch slot', () => {
    const other = granteeFromPrivateKey(`0x${'11'.repeat(32)}`);
    const keys = normaliseGrantees([COMPRESSED, COMPRESSED.toUpperCase(), other]);
    expect(keys).toEqual([COMPRESSED, other]);
  });

  it('fails the whole list rather than silently skipping a bad key', () => {
    expect(() => normaliseGrantees([COMPRESSED, 'not-a-key'])).toThrowError(InvalidPublicKeyError);
  });
});
