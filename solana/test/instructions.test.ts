/**
 * Instruction encoding.
 *
 * The account list order, the mint sizing and the Borsh payload are the parts of
 * this package that a single wrong byte would break only on chain, at the moment it
 * matters. They are built by pure functions precisely so they can be asserted here,
 * decoded back with the program's own Codama parsers.
 */

import { describe, expect, it } from 'vitest';
import { AccountRole, type TransactionSigner } from '@solana/kit';
import {
  parseCloseAttestationInstruction,
  parseCloseTokenizedAttestationInstruction,
  parseCreateTokenizedAttestationInstruction,
  SolanaAttestationServiceInstruction,
  identifySolanaAttestationServiceInstruction,
} from 'sas-lib';
import { getMintSize } from '@solana-program/token-2022';
import {
  SAS_PROGRAM_ADDRESS,
  TOKEN_NAME,
  TOKEN_SYMBOL,
  TOKEN_URI,
} from '../src/constants.ts';
import { buildIssueInstruction } from '../src/issue.ts';
import { buildCloseInstruction } from '../src/revoke.ts';
import {
  ASSOCIATED_TOKEN_PROGRAM_ADDRESS,
  deriveIssuerAddresses,
  deriveReferenceAddresses,
  TOKEN_2022_PROGRAM_ADDRESS,
} from '../src/pdas.ts';
import { decodeReferenceData, localSchemaAccount } from '../src/schema.ts';
import { COMMITMENT, DERIVATION_ID, ISSUER_AUTHORITY, REFERENCE_ID, SUBJECT } from './fixtures.ts';

const authority: TransactionSigner = {
  address: ISSUER_AUTHORITY,
  signTransactions: async () => [],
};

const data = {
  referenceId: REFERENCE_ID,
  commitment: COMMITMENT,
  expiresAt: 1_893_456_000n,
  derivationId: DERIVATION_ID,
  tierCount: 2,
};

const token = { name: TOKEN_NAME, symbol: TOKEN_SYMBOL, uri: TOKEN_URI };

async function build() {
  const addresses = await deriveIssuerAddresses(ISSUER_AUTHORITY);
  const reference = await deriveReferenceAddresses(addresses, SUBJECT);
  const instruction = buildIssueInstruction({
    authority,
    addresses,
    reference,
    subject: SUBJECT,
    schemaAccount: localSchemaAccount(addresses.credential),
    data,
    token,
  });
  return { addresses, reference, instruction };
}

describe('CreateTokenizedAttestation', () => {
  it('targets the SAS program with the right discriminator', async () => {
    const { instruction } = await build();
    expect(instruction.programAddress).toBe(SAS_PROGRAM_ADDRESS);
    expect(identifySolanaAttestationServiceInstruction(instruction.data as Uint8Array)).toBe(
      SolanaAttestationServiceInstruction.CreateTokenizedAttestation,
    );
  });

  it('lists the thirteen accounts in program order', async () => {
    const { addresses, reference, instruction } = await build();
    const parsed = parseCreateTokenizedAttestationInstruction(
      instruction as Parameters<typeof parseCreateTokenizedAttestationInstruction>[0],
    );
    expect(parsed.accounts.payer.address).toBe(ISSUER_AUTHORITY);
    expect(parsed.accounts.authority.address).toBe(ISSUER_AUTHORITY);
    expect(parsed.accounts.credential.address).toBe(addresses.credential);
    expect(parsed.accounts.schema.address).toBe(addresses.schema);
    expect(parsed.accounts.attestation.address).toBe(reference.attestation);
    expect(parsed.accounts.systemProgram.address).toBe('11111111111111111111111111111111');
    expect(parsed.accounts.schemaMint.address).toBe(addresses.schemaMint);
    expect(parsed.accounts.attestationMint.address).toBe(reference.attestationMint);
    expect(parsed.accounts.sasPda.address).toBe(addresses.sasPda);
    expect(parsed.accounts.recipientTokenAccount.address).toBe(reference.recipientTokenAccount);
    expect(parsed.accounts.recipient.address).toBe(SUBJECT);
    expect(parsed.accounts.tokenProgram.address).toBe(TOKEN_2022_PROGRAM_ADDRESS);
    expect(parsed.accounts.associatedTokenProgram.address).toBe(ASSOCIATED_TOKEN_PROGRAM_ADDRESS);
    expect(instruction.accounts).toHaveLength(13);
  });

  it('marks the issuer as the only signer, and the subject as read-only', async () => {
    const { instruction } = await build();
    const parsed = parseCreateTokenizedAttestationInstruction(
      instruction as Parameters<typeof parseCreateTokenizedAttestationInstruction>[0],
    );
    expect(parsed.accounts.payer.role).toBe(AccountRole.WRITABLE_SIGNER);
    expect(parsed.accounts.authority.role).toBe(AccountRole.READONLY_SIGNER);
    expect(parsed.accounts.recipient.role).toBe(AccountRole.READONLY);
    // The subject never signs: a reference is issued about someone, not by them.
    const signers = (instruction.accounts ?? []).filter(
      (a) => a.role === AccountRole.WRITABLE_SIGNER || a.role === AccountRole.READONLY_SIGNER,
    );
    expect(signers.map((a) => a.address)).toEqual([ISSUER_AUTHORITY, ISSUER_AUTHORITY]);
  });

  it('carries the subject as the nonce and the payload as Borsh data', async () => {
    const { instruction } = await build();
    const parsed = parseCreateTokenizedAttestationInstruction(
      instruction as Parameters<typeof parseCreateTokenizedAttestationInstruction>[0],
    );
    expect(parsed.data.nonce).toBe(SUBJECT);
    expect(parsed.data.expiry).toBe(data.expiresAt);
    expect(decodeReferenceData(Uint8Array.from(parsed.data.data))).toEqual(data);
  });

  it('mirrors expiresAt into the enforced expiry field', async () => {
    const { instruction } = await build();
    const parsed = parseCreateTokenizedAttestationInstruction(
      instruction as Parameters<typeof parseCreateTokenizedAttestationInstruction>[0],
    );
    expect(parsed.data.expiry).toBe(decodeReferenceData(Uint8Array.from(parsed.data.data)).expiresAt);
  });

  it('sizes the mint for exactly the extensions the program writes', async () => {
    const { addresses, reference, instruction } = await build();
    const parsed = parseCreateTokenizedAttestationInstruction(
      instruction as Parameters<typeof parseCreateTokenizedAttestationInstruction>[0],
    );
    const expected = getMintSize([
      {
        __kind: 'GroupMemberPointer',
        authority: addresses.sasPda,
        memberAddress: reference.attestationMint,
      },
      { __kind: 'NonTransferable' },
      {
        __kind: 'MetadataPointer',
        authority: addresses.sasPda,
        metadataAddress: reference.attestationMint,
      },
      { __kind: 'PermanentDelegate', delegate: addresses.sasPda },
      { __kind: 'MintCloseAuthority', closeAuthority: addresses.sasPda },
      {
        __kind: 'TokenMetadata',
        updateAuthority: addresses.sasPda,
        mint: reference.attestationMint,
        name: TOKEN_NAME,
        symbol: TOKEN_SYMBOL,
        uri: TOKEN_URI,
        additionalMetadata: new Map([
          ['attestation', reference.attestation as string],
          ['schema', addresses.schema as string],
        ]),
      },
      {
        __kind: 'TokenGroupMember',
        group: addresses.schemaMint,
        mint: reference.attestationMint,
        memberNumber: 1,
      },
    ]);
    expect(parsed.data.mintAccountSpace).toBe(expected);
    expect(parsed.data.name).toBe(TOKEN_NAME);
    expect(parsed.data.symbol).toBe(TOKEN_SYMBOL);
    expect(parsed.data.uri).toBe(TOKEN_URI);
  });

  it('grows the mint allocation when a longer token uri is supplied', async () => {
    const { addresses, reference } = await build();
    const longer = buildIssueInstruction({
      authority,
      addresses,
      reference,
      subject: SUBJECT,
      schemaAccount: localSchemaAccount(addresses.credential),
      data,
      token: { ...token, uri: `${TOKEN_URI}xxxxxxxxxx` },
    });
    const base = parseCreateTokenizedAttestationInstruction(
      (await build()).instruction as Parameters<typeof parseCreateTokenizedAttestationInstruction>[0],
    );
    const grown = parseCreateTokenizedAttestationInstruction(
      longer as Parameters<typeof parseCreateTokenizedAttestationInstruction>[0],
    );
    expect(grown.data.mintAccountSpace).toBe(base.data.mintAccountSpace + 10);
  });

  it('carries a self-contained token uri, with no host to go dark', async () => {
    expect(TOKEN_URI.startsWith('data:application/json,')).toBe(true);
  });
});

describe('close instructions', () => {
  it('uses CloseTokenizedAttestation when a soulbound token exists', async () => {
    const addresses = await deriveIssuerAddresses(ISSUER_AUTHORITY);
    const reference = await deriveReferenceAddresses(addresses, SUBJECT);
    const instruction = buildCloseInstruction({
      authority,
      addresses,
      reference,
      tokenized: true,
      attestationTokenAccount: reference.recipientTokenAccount,
    });

    expect(identifySolanaAttestationServiceInstruction(instruction.data as Uint8Array)).toBe(
      SolanaAttestationServiceInstruction.CloseTokenizedAttestation,
    );
    const parsed = parseCloseTokenizedAttestationInstruction(
      instruction as Parameters<typeof parseCloseTokenizedAttestationInstruction>[0],
    );
    expect(parsed.accounts.credential.address).toBe(addresses.credential);
    expect(parsed.accounts.attestation.address).toBe(reference.attestation);
    expect(parsed.accounts.attestationMint.address).toBe(reference.attestationMint);
    expect(parsed.accounts.sasPda.address).toBe(addresses.sasPda);
    expect(parsed.accounts.attestationTokenAccount.address).toBe(reference.recipientTokenAccount);
    expect(parsed.accounts.tokenProgram.address).toBe(TOKEN_2022_PROGRAM_ADDRESS);
    // Self-CPI back into SAS is how the CloseAttestationEvent reaches the tx log.
    expect(parsed.accounts.attestationProgram.address).toBe(SAS_PROGRAM_ADDRESS);
    expect(parsed.accounts.eventAuthority.address).toBe(addresses.eventAuthority);
  });

  it('falls back to CloseAttestation for a bare attestation', async () => {
    const addresses = await deriveIssuerAddresses(ISSUER_AUTHORITY);
    const reference = await deriveReferenceAddresses(addresses, SUBJECT);
    const instruction = buildCloseInstruction({
      authority,
      addresses,
      reference,
      tokenized: false,
      attestationTokenAccount: reference.recipientTokenAccount,
    });

    expect(identifySolanaAttestationServiceInstruction(instruction.data as Uint8Array)).toBe(
      SolanaAttestationServiceInstruction.CloseAttestation,
    );
    const parsed = parseCloseAttestationInstruction(
      instruction as Parameters<typeof parseCloseAttestationInstruction>[0],
    );
    expect(parsed.accounts.attestation.address).toBe(reference.attestation);
    expect(parsed.accounts.eventAuthority.address).toBe(addresses.eventAuthority);
  });

  it('requires the issuer to sign, and never the subject', async () => {
    const addresses = await deriveIssuerAddresses(ISSUER_AUTHORITY);
    const reference = await deriveReferenceAddresses(addresses, SUBJECT);
    const instruction = buildCloseInstruction({
      authority,
      addresses,
      reference,
      tokenized: true,
      attestationTokenAccount: reference.recipientTokenAccount,
    });
    const signers = (instruction.accounts ?? []).filter(
      (a) => a.role === AccountRole.WRITABLE_SIGNER || a.role === AccountRole.READONLY_SIGNER,
    );
    expect(new Set(signers.map((a) => a.address))).toEqual(new Set([ISSUER_AUTHORITY]));
    expect(signers.map((a) => a.address)).not.toContain(SUBJECT);
  });
});
