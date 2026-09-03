/**
 * Live cluster lifecycle: setup -> issue -> verify -> tamper -> revoke -> verify.
 *
 * Skipped unless an issuer keypair is provided and funded, so the unit suite stays
 * runnable with no credentials at all:
 *
 *   ZEGEL_SOLANA_KEYPAIR=/path/to/id.json \
 *   ZEGEL_SOLANA_RPC=https://api.devnet.solana.com \
 *   pnpm test
 *
 * Each run mints against a freshly generated subject, so it is repeatable and
 * never collides with a previous run's attestation PDA.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { generateKeyPairSigner, type KeyPairSigner } from '@solana/kit';
import { createIssuer, type ZegelIssuer } from '../src/issuer.ts';
import { issue } from '../src/issue.ts';
import { loadKeypairFile } from '../src/keypair.ts';
import { close, revoke } from '../src/revoke.ts';
import { verify } from '../src/verify.ts';
import { getBalanceSol, createRpc } from '../src/rpc.ts';
import { AttestationExistsError, AttestationNotExpiredError } from '../src/errors.ts';
import { COMMITMENT, DERIVATION_ID, REFERENCE_ID, TAMPERED_COMMITMENT } from './fixtures.ts';

const KEYPAIR_PATH = process.env['ZEGEL_SOLANA_KEYPAIR'];
const RPC_URL = process.env['ZEGEL_SOLANA_RPC'] ?? 'https://api.devnet.solana.com';
/** Enough for a credential, a schema, a group mint, an NFT mint and an ATA. */
const MIN_BALANCE_SOL = 0.05;

const reason = await unavailableReason();
if (reason) console.warn(`devnet integration test skipped: ${reason}`);

describe.skipIf(reason !== null)('devnet lifecycle', () => {
  let issuer: ZegelIssuer;
  let subject: KeyPairSigner;
  const signatures: Record<string, string> = {};

  beforeAll(async () => {
    issuer = await createIssuer({ rpcUrl: RPC_URL, keypair: await loadKeypairFile(KEYPAIR_PATH as string) });
    subject = await generateKeyPairSigner();
    if (issuer.setup.signature) signatures['setup'] = issuer.setup.signature;
  });

  it('sets up the credential, schema and schema mint idempotently', async () => {
    const again = await createIssuer({
      rpcUrl: RPC_URL,
      keypair: await loadKeypairFile(KEYPAIR_PATH as string),
    });
    expect(again.setup.created).toEqual({ credential: false, schema: false, schemaMint: false });
    expect(again.setup.signature).toBeNull();
    expect(again.addresses).toEqual(issuer.addresses);
  });

  it('issues a tokenized attestation and verifies it', async () => {
    const expiresAt = new Date(Date.now() + 7 * 24 * 3600 * 1000);
    const result = await issue({
      issuer,
      subject: subject.address,
      referenceId: REFERENCE_ID,
      commitment: COMMITMENT,
      expiresAt,
      derivationId: DERIVATION_ID,
    });
    signatures['issue'] = result.signature;
    expect(result.subject).toBe(subject.address);

    const verified = await verify({
      rpcUrl: RPC_URL,
      issuerAuthority: issuer.addresses.authority,
      subject: subject.address,
      referenceId: REFERENCE_ID,
      commitment: COMMITMENT,
    });
    expect(verified.status).toBe('valid');
    expect(verified.attestation).toBe(result.attestation);
    expect(verified.onchain?.commitment).toBe(COMMITMENT);
    expect(verified.onchain?.derivationId).toBe(DERIVATION_ID);
    expect(verified.tokenAccount).toBe(result.recipientTokenAccount);
  });

  it('rejects a tampered commitment against the live attestation', async () => {
    const verified = await verify({
      rpcUrl: RPC_URL,
      issuerAuthority: issuer.addresses.authority,
      subject: subject.address,
      referenceId: REFERENCE_ID,
      commitment: TAMPERED_COMMITMENT,
    });
    expect(verified.status).toBe('commitment-mismatch');
  });

  it('refuses to issue a second reference for the same subject', async () => {
    await expect(
      issue({
        issuer,
        subject: subject.address,
        referenceId: `0x${'22'.repeat(32)}`,
        commitment: COMMITMENT,
        expiresAt: new Date(Date.now() + 7 * 24 * 3600 * 1000),
        derivationId: DERIVATION_ID,
      }),
    ).rejects.toThrow(AttestationExistsError);
  });

  it('refuses to close a reference that has not expired', async () => {
    await expect(close({ issuer, subject: subject.address })).rejects.toThrow(AttestationNotExpiredError);
  });

  it('revokes, and the revocation is observable afterwards', async () => {
    const result = await revoke({ issuer, subject: subject.address, referenceId: REFERENCE_ID });
    signatures['revoke'] = result.signature;
    expect(result.tokenized).toBe(true);
    expect(result.referenceId).toBe(REFERENCE_ID);

    const verified = await verify({
      rpcUrl: RPC_URL,
      issuerAuthority: issuer.addresses.authority,
      subject: subject.address,
      referenceId: REFERENCE_ID,
      commitment: COMMITMENT,
    });
    expect(verified.status).toBe('revoked');
    expect(verified.revocation?.signature).toBe(result.signature);
    expect(verified.revocation?.instruction).toBe('CloseTokenizedAttestation');

    console.log('devnet signatures:', JSON.stringify(signatures, null, 2));
  });

  it('reports not-found for a subject that was never attested', async () => {
    const stranger = await generateKeyPairSigner();
    const verified = await verify({
      rpcUrl: RPC_URL,
      issuerAuthority: issuer.addresses.authority,
      subject: stranger.address,
      referenceId: REFERENCE_ID,
      commitment: COMMITMENT,
    });
    expect(verified.status).toBe('not-found');
  });
});

async function unavailableReason(): Promise<string | null> {
  if (!KEYPAIR_PATH) return 'set ZEGEL_SOLANA_KEYPAIR to run it';
  try {
    const signer = await loadKeypairFile(KEYPAIR_PATH);
    const balance = await getBalanceSol(createRpc(RPC_URL), signer.address);
    if (balance < MIN_BALANCE_SOL) {
      return `${signer.address} holds ${balance} SOL on ${RPC_URL}, needs at least ${MIN_BALANCE_SOL}`;
    }
    return null;
  } catch (error) {
    return `could not reach ${RPC_URL}: ${error instanceof Error ? error.message : String(error)}`;
  }
}
