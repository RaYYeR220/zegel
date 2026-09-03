import { describe, expect, it } from 'vitest';
import { address } from '@solana/kit';
import {
  deriveAttestationPda,
  deriveCredentialPda,
  deriveEventAuthorityAddress,
  deriveSasAuthorityAddress,
  deriveSchemaPda,
} from 'sas-lib';
import { CREDENTIAL_NAME, SAS_PROGRAM_ADDRESS, SCHEMA_NAME, SCHEMA_VERSION } from '../src/constants.ts';
import { deriveIssuerAddresses, deriveReferenceAddresses, TOKEN_2022_PROGRAM_ADDRESS } from '../src/pdas.ts';
import { findAssociatedTokenPda } from '@solana-program/token-2022';
import { ISSUER_AUTHORITY, OTHER_SUBJECT, SUBJECT } from './fixtures.ts';

describe('program identity', () => {
  it('targets the live Solana Attestation Service program', () => {
    expect(SAS_PROGRAM_ADDRESS).toBe('22zoJMtdu4tQc2PzL74ZUT7FrwgB1Udec8DdW4yw4BdG');
  });
});

describe('issuer address derivation', () => {
  it('is deterministic', async () => {
    const a = await deriveIssuerAddresses(ISSUER_AUTHORITY);
    const b = await deriveIssuerAddresses(ISSUER_AUTHORITY);
    expect(a).toEqual(b);
  });

  it('matches the seeds documented in the README', async () => {
    const derived = await deriveIssuerAddresses(ISSUER_AUTHORITY);
    const [credential] = await deriveCredentialPda({
      authority: ISSUER_AUTHORITY,
      name: CREDENTIAL_NAME,
    });
    const [schema] = await deriveSchemaPda({
      credential,
      name: SCHEMA_NAME,
      version: SCHEMA_VERSION,
    });
    expect(derived.credential).toBe(credential);
    expect(derived.schema).toBe(schema);
    expect(derived.sasPda).toBe(await deriveSasAuthorityAddress());
    expect(derived.eventAuthority).toBe(await deriveEventAuthorityAddress());
  });

  it('pins the addresses for the project authority', async () => {
    // Regression guard: changing CREDENTIAL_NAME, SCHEMA_NAME or SCHEMA_VERSION
    // silently relocates every account and orphans live attestations.
    const derived = await deriveIssuerAddresses(ISSUER_AUTHORITY);
    expect(derived.credential).toBe('E71jA1xf49cCJFVcvDxhqm8eDDF6mcf8VFgoCaWfpSen');
    expect(derived.schema).toBe('GpmsvJCNeKBkuwm25vY9vjzh89ojaqCiNActrZAq1EKC');
    expect(derived.schemaMint).toBe('H8LCwFpia1QvwRH3eZsNJg9731nRWPpQ3qbK3rJmKKua');
  });

  it('gives a different credential to a different authority', async () => {
    const other = await deriveIssuerAddresses(address('SysvarC1ock11111111111111111111111111111111'));
    const ours = await deriveIssuerAddresses(ISSUER_AUTHORITY);
    expect(other.credential).not.toBe(ours.credential);
    expect(other.schema).not.toBe(ours.schema);
  });
});

describe('reference address derivation', () => {
  it('keys the attestation on the subject', async () => {
    const issuer = await deriveIssuerAddresses(ISSUER_AUTHORITY);
    const mine = await deriveReferenceAddresses(issuer, SUBJECT);
    const theirs = await deriveReferenceAddresses(issuer, OTHER_SUBJECT);
    expect(mine.attestation).not.toBe(theirs.attestation);

    const [expected] = await deriveAttestationPda({
      credential: issuer.credential,
      schema: issuer.schema,
      nonce: SUBJECT,
    });
    expect(mine.attestation).toBe(expected);
  });

  it('derives the recipient account as a Token-2022 associated token account', async () => {
    const issuer = await deriveIssuerAddresses(ISSUER_AUTHORITY);
    const { attestationMint, recipientTokenAccount } = await deriveReferenceAddresses(issuer, SUBJECT);
    const [expected] = await findAssociatedTokenPda({
      mint: attestationMint,
      owner: SUBJECT,
      tokenProgram: TOKEN_2022_PROGRAM_ADDRESS,
    });
    expect(recipientTokenAccount).toBe(expected);
  });

  it('binds the attestation mint to the attestation', async () => {
    const issuer = await deriveIssuerAddresses(ISSUER_AUTHORITY);
    const mine = await deriveReferenceAddresses(issuer, SUBJECT);
    const theirs = await deriveReferenceAddresses(issuer, OTHER_SUBJECT);
    expect(mine.attestationMint).not.toBe(theirs.attestationMint);
  });

  it('is independent of the reference id, so one subject holds one live reference', async () => {
    // The nonce is the subject pubkey by design. Two references for the same
    // subject would collide at the same PDA, which is why issue() refuses.
    const issuer = await deriveIssuerAddresses(ISSUER_AUTHORITY);
    const first = await deriveReferenceAddresses(issuer, SUBJECT);
    const second = await deriveReferenceAddresses(issuer, SUBJECT);
    expect(first.attestation).toBe(second.attestation);
  });
});
