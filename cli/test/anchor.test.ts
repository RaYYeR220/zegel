import { describe, expect, it } from 'vitest';

import {
  ANCHORED_TEST_VECTOR,
  BASE_RPCS,
  DEFAULT_BASE_RPC,
  ZEGEL_ANCHOR_ADDRESS,
  ZEGEL_ANCHOR_CHAIN_ID,
  anchorAddressFromEnv,
  anchorNote,
  baseRpcFromEnv,
  verifyCallData,
  type AnchorReading,
} from '../src/core/anchor.js';

describe('anchor configuration', () => {
  it('defaults to the contract deployed on Base mainnet', () => {
    expect(ZEGEL_ANCHOR_ADDRESS).toBe('0xbcB85eCdeF23a11D5015b260cC4eDCc0c250f42e');
    expect(ZEGEL_ANCHOR_CHAIN_ID).toBe(8453);
    expect(anchorAddressFromEnv({})).toBe(ZEGEL_ANCHOR_ADDRESS);
  });

  it('lets ZEGEL_ANCHOR_ADDRESS point somewhere else', () => {
    expect(anchorAddressFromEnv({ ZEGEL_ANCHOR_ADDRESS: '0xdead' })).toBe('0xdead');
  });

  it('ignores an empty override rather than reading a blank address', () => {
    expect(anchorAddressFromEnv({ ZEGEL_ANCHOR_ADDRESS: '' })).toBe(ZEGEL_ANCHOR_ADDRESS);
  });

  it('defaults the RPC to the chain\'s own endpoint', () => {
    expect(DEFAULT_BASE_RPC).toBe('https://mainnet.base.org');
    expect(BASE_RPCS[0]).toBe(DEFAULT_BASE_RPC);
    expect(BASE_RPCS.length).toBeGreaterThan(1);
  });

  it('prefers ZEGEL_BASE_RPC, and accepts BASE_RPC_URL', () => {
    expect(baseRpcFromEnv({ ZEGEL_BASE_RPC: 'https://a.invalid' })).toBe('https://a.invalid');
    expect(baseRpcFromEnv({ BASE_RPC_URL: 'https://b.invalid' })).toBe('https://b.invalid');
    expect(
      baseRpcFromEnv({ ZEGEL_BASE_RPC: 'https://a.invalid', BASE_RPC_URL: 'https://b.invalid' }),
    ).toBe('https://a.invalid');
  });

  it('falls back to the built-in list when nothing is configured', () => {
    expect(baseRpcFromEnv({})).toBeUndefined();
    expect(baseRpcFromEnv({ ZEGEL_BASE_RPC: '' })).toBeUndefined();
  });
});

describe('call encoding', () => {
  it('encodes verify(bytes32,bytes32) from the shared ABI, not a pasted selector', () => {
    const data = verifyCallData(ANCHORED_TEST_VECTOR.referenceId, ANCHORED_TEST_VECTOR.commitment);
    expect(data.slice(0, 10)).toBe('0x4e8fee00');
    expect(data).toBe(
      `0x4e8fee00${ANCHORED_TEST_VECTOR.referenceId.slice(2)}${ANCHORED_TEST_VECTOR.commitment.slice(2)}`,
    );
    expect(data).toHaveLength(2 + 8 + 64 + 64);
  });
});

describe('the note under the verdict', () => {
  const base: AnchorReading = { status: 'valid', code: 1 };

  it('is absent when the contract told us nothing extra', () => {
    expect(anchorNote(base)).toBeUndefined();
  });

  it('names the issuer and the expiry', () => {
    const note = anchorNote({ ...base, issuer: '0xabc', expiresAt: '2026-12-02T23:36:25.000Z' });
    expect(note).toBe('issuer 0xabc, expires 2026-12-02T23:36:25.000Z');
  });

  it('reports a revocation time in place of the expiry, because that is the live fact', () => {
    const note = anchorNote({
      ...base,
      status: 'revoked',
      code: 3,
      issuer: '0xabc',
      expiresAt: '2026-12-02T23:36:25.000Z',
      revokedAt: '2026-09-10T00:00:00.000Z',
    });
    expect(note).toContain('revoked 2026-09-10T00:00:00.000Z');
    expect(note).not.toContain('expires');
  });
});

describe('the on-chain test vector', () => {
  it('is a well-formed 32-byte reference and commitment', () => {
    expect(ANCHORED_TEST_VECTOR.referenceId).toMatch(/^0x[0-9a-f]{64}$/);
    expect(ANCHORED_TEST_VECTOR.commitment).toMatch(/^0x[0-9a-f]{64}$/);
    expect(ANCHORED_TEST_VECTOR.issuer).toMatch(/^0x[0-9a-fA-F]{40}$/);
  });
});
