/**
 * The verify status matrix.
 *
 * Every branch is exercised against served account bytes rather than a live
 * cluster, because several of the states that matter most — a paused schema, an
 * attestation that has already lapsed, a subject whose PDA history has been
 * pruned — cannot be conjured on demand on devnet. The happy path is proved for
 * real in the devnet integration test.
 */

import { describe, expect, it } from 'vitest';
import { address } from '@solana/kit';
import { getBase58Decoder } from '@solana/kit';
import { getCloseAttestationInstruction, getCloseTokenizedAttestationInstruction } from 'sas-lib';
import { deriveIssuerAddresses, deriveReferenceAddresses } from '../src/pdas.ts';
import { encodeReferenceData } from '../src/schema.ts';
import { SAS_PROGRAM_ADDRESS } from '../src/constants.ts';
import { verify } from '../src/verify.ts';
import type { VerifyResult } from '../src/types.ts';
import {
  attestationAccountBytes,
  COMMITMENT,
  DERIVATION_ID,
  fakeRpc,
  type FakeRpcState,
  ISSUER_AUTHORITY,
  REFERENCE_ID,
  schemaAccountBytes,
  SUBJECT,
  TAMPERED_COMMITMENT,
} from './fixtures.ts';

const NOW = new Date('2026-09-03T12:00:00.000Z');
const FUTURE = 1_893_456_000n; // 2030-01-01
const PAST = 1_600_000_000n; // 2020-09-13
const NO_TOKEN_ACCOUNT = address('11111111111111111111111111111111');

interface SceneOptions {
  anchoredReferenceId?: string;
  anchoredCommitment?: string;
  expiry?: bigint;
  schemaPaused?: boolean;
  omitSchema?: boolean;
  omitAttestation?: boolean;
  signatures?: FakeRpcState['signatures'];
  transactionInstructions?: FakeRpcState['transactionInstructions'];
  tokenized?: boolean;
}

async function scene(options: SceneOptions = {}) {
  const issuer = await deriveIssuerAddresses(ISSUER_AUTHORITY);
  const reference = await deriveReferenceAddresses(issuer, SUBJECT);

  const accounts: Record<string, Uint8Array> = {};
  if (!options.omitSchema) {
    accounts[issuer.schema] = schemaAccountBytes({
      credential: issuer.credential,
      isPaused: options.schemaPaused ?? false,
    });
  }
  if (!options.omitAttestation) {
    accounts[reference.attestation] = attestationAccountBytes({
      nonce: SUBJECT,
      credential: issuer.credential,
      schema: issuer.schema,
      signer: ISSUER_AUTHORITY,
      expiry: options.expiry ?? FUTURE,
      tokenAccount:
        options.tokenized === false ? NO_TOKEN_ACCOUNT : reference.recipientTokenAccount,
      data: encodeReferenceData({
        referenceId: options.anchoredReferenceId ?? REFERENCE_ID,
        commitment: options.anchoredCommitment ?? COMMITMENT,
        expiresAt: options.expiry ?? FUTURE,
        derivationId: DERIVATION_ID,
        tierCount: 2,
      }),
    });
  }

  const state: FakeRpcState = {
    accounts,
    ...(options.signatures ? { signatures: options.signatures } : {}),
    ...(options.transactionInstructions
      ? { transactionInstructions: options.transactionInstructions }
      : {}),
  };
  return { issuer, reference, rpc: fakeRpc(state) };
}

async function check(options: SceneOptions & { commitment?: string; referenceId?: string }): Promise<VerifyResult> {
  const { rpc } = await scene(options);
  return verify({
    rpc,
    issuerAuthority: ISSUER_AUTHORITY,
    subject: SUBJECT,
    referenceId: options.referenceId ?? REFERENCE_ID,
    ...(options.commitment === undefined ? {} : { commitment: options.commitment }),
    now: NOW,
  });
}

describe('verify status matrix', () => {
  it('valid: live attestation, matching commitment', async () => {
    const result = await check({ commitment: COMMITMENT });
    expect(result.status).toBe('valid');
    expect(result.onchain?.commitment).toBe(COMMITMENT);
    expect(result.onchain?.derivationId).toBe(DERIVATION_ID);
    expect(result.onchain?.tierCount).toBe(2);
    expect(result.schemaMatchesExpected).toBe(true);
    expect(result.schemaPaused).toBe(false);
  });

  it('commitment-mismatch: a tampered claim set fails', async () => {
    // The negative control. One byte differs in the commitment the verifier was
    // shown; nothing else about the reference has changed.
    const result = await check({ commitment: TAMPERED_COMMITMENT });
    expect(result.status).toBe('commitment-mismatch');
    expect(result.detail).toContain(TAMPERED_COMMITMENT);
    expect(result.detail).toContain(COMMITMENT);
  });

  it('commitment-mismatch outranks expired', async () => {
    const result = await check({ commitment: TAMPERED_COMMITMENT, expiry: PAST });
    expect(result.status).toBe('commitment-mismatch');
  });

  it('commitment-mismatch outranks a paused schema', async () => {
    const result = await check({ commitment: TAMPERED_COMMITMENT, schemaPaused: true });
    expect(result.status).toBe('commitment-mismatch');
  });

  it('reference-mismatch: the subject anchors a different reference', async () => {
    const result = await check({
      commitment: COMMITMENT,
      anchoredReferenceId: `0x${'22'.repeat(32)}`,
    });
    expect(result.status).toBe('reference-mismatch');
    expect(result.detail).toContain(`0x${'22'.repeat(32)}`);
  });

  it('reference-mismatch outranks commitment-mismatch', async () => {
    const result = await check({
      commitment: TAMPERED_COMMITMENT,
      anchoredReferenceId: `0x${'22'.repeat(32)}`,
    });
    expect(result.status).toBe('reference-mismatch');
  });

  it('expired: past the expiry the program enforces', async () => {
    const result = await check({ commitment: COMMITMENT, expiry: PAST });
    expect(result.status).toBe('expired');
    expect(result.detail).toContain('2020-09-13');
  });

  it('schema-paused: the issuer suspended the whole schema', async () => {
    const result = await check({ commitment: COMMITMENT, schemaPaused: true });
    expect(result.status).toBe('schema-paused');
    expect(result.schemaPaused).toBe(true);
  });

  it('not-found: the issuer never set up a credential on this cluster', async () => {
    const result = await check({ omitSchema: true, omitAttestation: true, commitment: COMMITMENT });
    expect(result.status).toBe('not-found');
    expect(result.detail).toContain('never set up');
  });

  it('not-found: no attestation and no history at the address', async () => {
    const result = await check({ omitAttestation: true, commitment: COMMITMENT });
    expect(result.status).toBe('not-found');
    expect(result.revocation).toBeUndefined();
    // Absence of history is not proof of absence, and the answer says so.
    expect(result.detail).toContain('prune history');
  });

  it('revoked: the account is gone but the closing transaction is not', async () => {
    const { issuer } = await scene();
    const { attestation } = await deriveReferenceAddresses(issuer, SUBJECT);
    const closeIx = getCloseAttestationInstruction({
      payer: { address: ISSUER_AUTHORITY, signTransactions: async () => [] },
      authority: { address: ISSUER_AUTHORITY, signTransactions: async () => [] },
      credential: issuer.credential,
      attestation,
    });

    const result = await check({
      omitAttestation: true,
      commitment: COMMITMENT,
      signatures: {
        [attestation]: [
          { signature: 'CLOSEsig1111111111111111111111111111111111111111111111111111111111', slot: 42n, blockTime: 1_756_900_000n, err: null },
        ],
      },
      transactionInstructions: [
        {
          programId: SAS_PROGRAM_ADDRESS,
          data: getBase58Decoder().decode(closeIx.data),
        },
      ],
    });

    expect(result.status).toBe('revoked');
    expect(result.revocation?.instruction).toBe('CloseAttestation');
    expect(result.revocation?.slot).toBe(42);
    expect(result.revocation?.signature).toContain('CLOSEsig');
    expect(result.detail).toContain('closed by the issuer');
  });

  it('finds a close that happened inside a CPI', async () => {
    const { issuer } = await scene();
    const { attestation } = await deriveReferenceAddresses(issuer, SUBJECT);
    const closeIx = getCloseAttestationInstruction({
      payer: { address: ISSUER_AUTHORITY, signTransactions: async () => [] },
      authority: { address: ISSUER_AUTHORITY, signTransactions: async () => [] },
      credential: issuer.credential,
      attestation,
    });

    const rpc = fakeRpc({
      accounts: {
        [issuer.schema]: schemaAccountBytes({ credential: issuer.credential }),
      },
      signatures: {
        [attestation]: [
          { signature: 'CPIsig111111111111111111111111111111111111111111111111111111111111', slot: 11n, blockTime: 1_756_900_000n, err: null },
        ],
      },
      // Top level is some wrapper the client cannot name; the close is nested.
      transactionInstructions: [{ programId: SAS_PROGRAM_ADDRESS, data: '1' }],
      innerTransactionInstructions: [
        { programId: SAS_PROGRAM_ADDRESS, data: getBase58Decoder().decode(closeIx.data) },
      ],
    });

    const result = await verify({
      rpc,
      issuerAuthority: ISSUER_AUTHORITY,
      subject: SUBJECT,
      referenceId: REFERENCE_ID,
      commitment: COMMITMENT,
      now: NOW,
    });
    expect(result.status).toBe('revoked');
    expect(result.revocation?.instruction).toBe('CloseAttestation');
  });

  it('refuses to call it a revocation when no close instruction can be identified', async () => {
    // Attestation addresses are derivable by anyone, so anyone can put a transaction
    // at one. "Account gone, something happened here" must not become "the issuer
    // revoked it" — that would attribute an act to the issuer for the price of a fee.
    const { issuer } = await scene();
    const { attestation } = await deriveReferenceAddresses(issuer, SUBJECT);
    const result = await check({
      omitAttestation: true,
      commitment: COMMITMENT,
      signatures: {
        [attestation]: [
          { signature: 'SPAMsig11111111111111111111111111111111111111111111111111111111111', slot: 7n, blockTime: 1_756_900_000n, err: null },
        ],
      },
      // A transaction that touches the address but contains no SAS close.
      transactionInstructions: [
        { programId: '11111111111111111111111111111111', data: '3Bxs4h24hBtQy9rw' },
      ],
    });
    expect(result.status).toBe('not-found');
    expect(result.revocation).toBeUndefined();
    expect(result.detail).toContain('1 successful transaction(s)');
    expect(result.detail).toContain('not evidence the issuer revoked anything');
  });

  it('refuses to call it a revocation when the transaction cannot be fetched at all', async () => {
    const { issuer } = await scene();
    const { attestation } = await deriveReferenceAddresses(issuer, SUBJECT);
    const result = await check({
      omitAttestation: true,
      commitment: COMMITMENT,
      signatures: {
        [attestation]: [
          { signature: 'UNKNOWNsig11111111111111111111111111111111111111111111111111111111', slot: 7n, blockTime: null, err: null },
        ],
      },
    });
    expect(result.status).toBe('not-found');
    expect(result.revocation).toBeUndefined();
  });

  it('finds the close even when newer traffic was sent to the address afterwards', async () => {
    const { issuer } = await scene();
    const { attestation } = await deriveReferenceAddresses(issuer, SUBJECT);
    const closeIx = getCloseTokenizedAttestationInstruction({
      payer: { address: ISSUER_AUTHORITY, signTransactions: async () => [] },
      authority: { address: ISSUER_AUTHORITY, signTransactions: async () => [] },
      credential: issuer.credential,
      attestation,
      attestationMint: (await deriveReferenceAddresses(issuer, SUBJECT)).attestationMint,
      sasPda: issuer.sasPda,
      attestationTokenAccount: (await deriveReferenceAddresses(issuer, SUBJECT)).recipientTokenAccount,
    });

    const accounts: Record<string, Uint8Array> = {
      [issuer.schema]: schemaAccountBytes({ credential: issuer.credential }),
    };
    const closeData = getBase58Decoder().decode(closeIx.data);
    const rpc = fakeRpc({
      accounts,
      signatures: {
        [attestation]: [
          { signature: 'NEWERsig1111111111111111111111111111111111111111111111111111111111', slot: 99n, blockTime: 1_756_999_000n, err: null },
          { signature: 'CLOSEsig1111111111111111111111111111111111111111111111111111111111', slot: 42n, blockTime: 1_756_900_000n, err: null },
        ],
      },
      transactionsBySignature: {
        NEWERsig1111111111111111111111111111111111111111111111111111111111: [
          { programId: '11111111111111111111111111111111', data: '3Bxs4h24hBtQy9rw' },
        ],
        CLOSEsig1111111111111111111111111111111111111111111111111111111111: [
          { programId: SAS_PROGRAM_ADDRESS, data: closeData },
        ],
      },
    });

    const result = await verify({
      rpc,
      issuerAuthority: ISSUER_AUTHORITY,
      subject: SUBJECT,
      referenceId: REFERENCE_ID,
      commitment: COMMITMENT,
      now: NOW,
    });
    expect(result.status).toBe('revoked');
    expect(result.revocation?.instruction).toBe('CloseTokenizedAttestation');
    expect(result.revocation?.slot).toBe(42);
  });

  it('ignores failed transactions when looking for a revocation', async () => {
    const { issuer } = await scene();
    const { attestation } = await deriveReferenceAddresses(issuer, SUBJECT);
    const result = await check({
      omitAttestation: true,
      commitment: COMMITMENT,
      signatures: {
        [attestation]: [
          { signature: 'FAILEDsig111111111111111111111111111111111111111111111111111111111', slot: 9n, blockTime: null, err: { InstructionError: [0, 'Custom'] } },
        ],
      },
    });
    expect(result.status).toBe('not-found');
  });

  it('skips the history lookup when asked to', async () => {
    const calls: string[] = [];
    const issuer = await deriveIssuerAddresses(ISSUER_AUTHORITY);
    const rpc = fakeRpc({
      accounts: { [issuer.schema]: schemaAccountBytes({ credential: issuer.credential }) },
      calls,
    });
    const result = await verify({
      rpc,
      issuerAuthority: ISSUER_AUTHORITY,
      subject: SUBJECT,
      referenceId: REFERENCE_ID,
      commitment: COMMITMENT,
      checkRevocationHistory: false,
      now: NOW,
    });
    expect(result.status).toBe('not-found');
    expect(calls.some((c) => c.startsWith('getSignaturesForAddress'))).toBe(false);
  });
});

describe('verify inputs', () => {
  it('says so when no commitment was supplied to check', async () => {
    const result = await check({});
    expect(result.status).toBe('valid');
    expect(result.detail).toContain('No commitment was supplied');
  });

  it('accepts unprefixed hex', async () => {
    const result = await check({ commitment: COMMITMENT.slice(2).toUpperCase(), referenceId: REFERENCE_ID.slice(2) });
    expect(result.status).toBe('valid');
  });

  it('rejects a malformed reference id before touching the network', async () => {
    await expect(check({ referenceId: 'not-hex', commitment: COMMITMENT })).rejects.toThrow(/referenceId/);
  });

  it('needs an rpc client or an rpc url', async () => {
    await expect(
      verify({ issuerAuthority: ISSUER_AUTHORITY, subject: SUBJECT, referenceId: REFERENCE_ID }),
    ).rejects.toThrow(TypeError);
  });

  it('reports the derived addresses so a third party can reproduce them', async () => {
    const result = await check({ commitment: COMMITMENT });
    const issuer = await deriveIssuerAddresses(ISSUER_AUTHORITY);
    const reference = await deriveReferenceAddresses(issuer, SUBJECT);
    expect(result.credential).toBe(issuer.credential);
    expect(result.schema).toBe(issuer.schema);
    expect(result.attestation).toBe(reference.attestation);
    expect(result.attestationMint).toBe(reference.attestationMint);
    expect(result.tokenAccount).toBe(reference.recipientTokenAccount);
  });
});
