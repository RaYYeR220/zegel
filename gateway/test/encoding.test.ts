import {
  decodeAbiParameters,
  encodePacked,
  hexToBigInt,
  keccak256,
  numberToHex,
  slice,
  stringToHex,
  type Hex,
} from 'viem';
import { describe, expect, it } from 'vitest';

import { canonicalDigest, canonicalize } from '../../packages/sdk/src/canonical.ts';
import { decodeQuery, encodeResult } from '../src/ccip.ts';
import { decodeDnsName } from '../src/dns.ts';
import { envelopeDigest, parseEnvelope } from '../src/envelope.ts';
import { makeSignatureHash } from '../src/signing.ts';

import {
  ALICE,
  ALICE_NODE,
  dataCallData,
  dnsEncode,
  envelopeText,
  gatewaySigner,
  RESOLVER,
  resolveCallData,
  sampleEnvelope,
} from './helpers.ts';

/** secp256k1 group order / 2, the ceiling `SignatureVerifier` enforces on `s`. */
const HALF_ORDER = 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0n;

describe('signature digest', () => {
  it('matches the packed layout the resolver hashes', async () => {
    const callData = dataCallData(ALICE_NODE);
    const result = stringToHex(envelopeText());
    const expires = 1_800_000_000n;

    // Built by a different route than the implementation: abi.encodePacked of the
    // five fields, exactly as SignatureVerifier.makeSignatureHash does on chain.
    const expected = keccak256(
      encodePacked(
        ['bytes2', 'address', 'uint64', 'bytes32', 'bytes32'],
        ['0x1900', RESOLVER, expires, keccak256(callData), keccak256(result)],
      ),
    );

    expect(makeSignatureHash(RESOLVER, expires, callData, result)).toBe(expected);
  });

  it('changes when any bound field changes', async () => {
    const callData = dataCallData(ALICE_NODE);
    const result = stringToHex(envelopeText());
    const base = makeSignatureHash(RESOLVER, 1n, callData, result);

    expect(makeSignatureHash('0x000000000000000000000000000000000000dEaD', 1n, callData, result)).not.toBe(base);
    expect(makeSignatureHash(RESOLVER, 2n, callData, result)).not.toBe(base);
    expect(makeSignatureHash(RESOLVER, 1n, dataCallData(ALICE_NODE, 'other'), result)).not.toBe(base);
    expect(makeSignatureHash(RESOLVER, 1n, callData, '0x00')).not.toBe(base);
  });

  it('produces a canonical low-s signature the resolver will not reject as malleable', async () => {
    const callData = dataCallData(ALICE_NODE);
    const result = stringToHex(envelopeText());
    const signature = await gatewaySigner.signResponse(RESOLVER, 1_800_000_000n, callData, result);

    expect(signature).toHaveLength(132);
    const s = hexToBigInt(slice(signature, 32, 64));
    expect(s).toBeLessThanOrEqual(HALF_ORDER);
    expect(hexToBigInt(slice(signature, 64, 65))).toBeGreaterThanOrEqual(27n);
    expect(hexToBigInt(slice(signature, 64, 65))).toBeLessThanOrEqual(28n);
  });
});

describe('callData decoding', () => {
  it('reads a direct data() query', () => {
    const query = decodeQuery(dataCallData(ALICE_NODE));
    expect(query).toEqual({ kind: 'data', node: ALICE_NODE, key: 'zegel.envelope.v1' });
  });

  it('reads a resolve() query and recovers the name', () => {
    const query = decodeQuery(resolveCallData(ALICE, ALICE_NODE));
    expect(query).toEqual({
      kind: 'resolve',
      name: ALICE,
      node: ALICE_NODE,
      key: 'zegel.envelope.v1',
    });
  });

  /** The asymmetry that breaks offchain resolvers silently, pinned in both directions. */
  it('wraps the result once more for resolve() than for data()', () => {
    const envelope = stringToHex(envelopeText());
    const direct = encodeResult(decodeQuery(dataCallData(ALICE_NODE)), envelope);
    const wildcard = encodeResult(decodeQuery(resolveCallData(ALICE, ALICE_NODE)), envelope);

    expect(direct).toBe(envelope);
    expect(decodeAbiParameters([{ type: 'bytes' }], wildcard)[0]).toBe(envelope);
  });
});

describe('DNS wire names', () => {
  it('round-trips a two-label name', () => {
    expect(decodeDnsName(dnsEncode(ALICE))).toBe(ALICE);
  });

  it('round-trips a subname', () => {
    expect(decodeDnsName(dnsEncode('reference.alice.eth'))).toBe('reference.alice.eth');
  });

  it('reads the root as the empty name', () => {
    expect(decodeDnsName('0x00')).toBe('');
  });

  it('rejects a label longer than 63 bytes', () => {
    const oversized: Hex = `0x40${'61'.repeat(64)}00`;
    expect(() => decodeDnsName(oversized)).toThrow(/63-byte limit/);
  });

  it('rejects trailing bytes after the root label', () => {
    expect(() => decodeDnsName(`${dnsEncode(ALICE)}ff` as Hex)).toThrow(/trailing bytes/);
  });
});

describe('envelope bytes', () => {
  /**
   * The commitment scheme only holds if every module hashes the same way. The
   * gateway deliberately does not re-encode the envelope, so this asserts that the
   * digest it computes over the published bytes is the digest `@zegel/sdk` computes
   * over the object.
   */
  it('digests identically to canonicalDigest in the shared encoder', () => {
    const envelope = sampleEnvelope();
    expect(envelopeDigest(canonicalize(envelope))).toBe(canonicalDigest(envelope));
  });

  it('serves the exact bytes it was given, not a re-serialisation', () => {
    // Same value, non-canonical key order and with whitespace.
    const text = JSON.stringify(sampleEnvelope(), null, 2);
    const parsed = parseEnvelope(text);

    expect(parsed.text).toBe(text);
    expect(parsed.bytes).toBe(stringToHex(text));
    expect(parsed.digest).toBe(envelopeDigest(text));
    expect(parsed.digest).not.toBe(canonicalDigest(sampleEnvelope()));
  });

  it('reads the expiry as epoch seconds', () => {
    const parsed = parseEnvelope(envelopeText({ expiresAt: '2027-01-02T03:04:05.000Z' }));
    expect(parsed.expiresAtSeconds).toBe(Math.floor(Date.parse('2027-01-02T03:04:05.000Z') / 1000));
  });

  it('rejects a referenceId that is not 32 bytes', () => {
    const text = JSON.stringify({ ...sampleEnvelope(), referenceId: '0x01' });
    expect(() => parseEnvelope(text)).toThrow(/referenceId/);
  });

  it('rejects an expiry that precedes issuance', () => {
    const text = envelopeText({ issuedAt: '2027-01-01T00:00:00.000Z', expiresAt: '2026-01-01T00:00:00.000Z' });
    expect(() => parseEnvelope(text)).toThrow(/expiresAt is not after issuedAt/);
  });

  it('rejects an ACT publisher that is not a compressed public key', () => {
    const envelope = sampleEnvelope();
    const text = JSON.stringify({
      ...envelope,
      tiers: [{ ...envelope.tiers[0], actPublisher: '0xdead' }],
    });
    expect(() => parseEnvelope(text)).toThrow(/compressed secp256k1 public key/);
  });

  it('rejects a revocationHint without a chain', () => {
    const text = JSON.stringify({
      ...sampleEnvelope(),
      revocationHint: { contract: '0x1111111111111111111111111111111111111111' },
    });
    expect(() => parseEnvelope(text)).toThrow(/chainId/);
  });
});

describe('numeric encoding', () => {
  it('encodes expires as eight big-endian bytes, as uint64 packs on chain', () => {
    expect(numberToHex(1n, { size: 8 })).toBe('0x0000000000000001');
  });
});
