/**
 * Revocation and closure.
 *
 * SAS has no update instruction and no revoked flag: an attestation is either
 * there or it is not. Withdrawing a reference therefore means closing the
 * attestation PDA — and for a tokenized attestation, burning the soulbound NFT
 * and closing its mint in the same instruction, which the program can do because
 * it holds PermanentDelegate and MintCloseAuthority.
 *
 * `revoke` and `close` reach the same on-chain primitive from opposite intents:
 *
 *   revoke  the issuer withdraws a live reference before its expiry
 *   close   the issuer reclaims rent from a reference that already lapsed
 *
 * `close` refuses a reference that has not expired. Closing a live one is
 * revocation, and an operation with that consequence should have to be named.
 */

import { address, type Address, type Instruction, type TransactionSigner } from '@solana/kit';
import {
  fetchMaybeAttestation,
  fetchSchema,
  getCloseAttestationInstruction,
  getCloseTokenizedAttestationInstruction,
} from 'sas-lib';
import type { ZegelIssuerContext } from './context.ts';
import {
  AttestationNotExpiredError,
  AttestationNotFoundError,
  ReferenceMismatchError,
} from './errors.ts';
import { hexEqual, normalizeHex32 } from './hex.ts';
import {
  deriveReferenceAddresses,
  type IssuerAddresses,
  type ReferenceAddresses,
  TOKEN_2022_PROGRAM_ADDRESS,
} from './pdas.ts';
import { sendInstructions } from './rpc.ts';
import { assertSchemaMatchesExpected, decodeReferenceData } from './schema.ts';
import type { RevokeResult } from './types.ts';

/** The `tokenAccount` field of a non-tokenized attestation. */
const NO_TOKEN_ACCOUNT = '11111111111111111111111111111111';

export interface RevokeOptions {
  issuer: ZegelIssuerContext;
  subject: Address | string;
  /**
   * The reference expected to be anchored there. Checked before closing, so a
   * stale id cannot silently tear down whatever the subject currently holds.
   * Omit to close whatever is present.
   */
  referenceId?: string;
}

export interface CloseOptions extends RevokeOptions {
  /** Close even though the reference has not expired. This is a revocation; say so. */
  force?: boolean;
}

export async function revoke(options: RevokeOptions): Promise<RevokeResult> {
  return closeAttestation(options, { requireExpired: false });
}

export async function close(options: CloseOptions): Promise<RevokeResult> {
  return closeAttestation(options, { requireExpired: options.force !== true });
}

async function closeAttestation(
  options: RevokeOptions,
  { requireExpired }: { requireExpired: boolean },
): Promise<RevokeResult> {
  const { issuer } = options;
  const { rpc, authority, addresses } = issuer;
  const { credential, schema } = addresses;

  const subject = address(String(options.subject));
  const { attestation, attestationMint, recipientTokenAccount } = await deriveReferenceAddresses(
    { credential, schema },
    subject,
  );

  const account = await fetchMaybeAttestation(rpc, attestation);
  if (!account.exists) throw new AttestationNotFoundError(attestation);

  const schemaAccount = await fetchSchema(rpc, schema);
  // Same reason as verify(): a same-width field reorder decodes cleanly into swapped
  // values, and the reference id read here is the guard against closing the wrong one.
  assertSchemaMatchesExpected(schemaAccount.data);
  const data = decodeReferenceData(Uint8Array.from(account.data.data), schemaAccount.data);

  if (options.referenceId !== undefined) {
    const expected = normalizeHex32('referenceId', options.referenceId);
    if (!hexEqual(expected, data.referenceId)) {
      throw new ReferenceMismatchError(expected, data.referenceId);
    }
  }

  if (requireExpired) {
    // Expiry 0 means the attestation never lapses, so it can never be "already
    // expired" — without this it would read as 1970 and close() would quietly
    // revoke a permanent reference.
    const now = BigInt(Math.floor(Date.now() / 1000));
    const expiry = account.data.expiry;
    if (expiry === 0n || expiry > now) {
      throw new AttestationNotExpiredError(attestation, expiry);
    }
  }

  const tokenized = String(account.data.tokenAccount) !== NO_TOKEN_ACCOUNT;

  const instruction = buildCloseInstruction({
    authority,
    addresses,
    reference: { attestation, attestationMint, recipientTokenAccount },
    tokenized,
    // Prefer the token account the program itself recorded over our derivation.
    attestationTokenAccount: tokenized ? account.data.tokenAccount : recipientTokenAccount,
  });

  const signature = await sendInstructions(rpc, authority, [instruction], {
    computeUnitLimit: 200_000,
    ...issuer.sendOptions,
  });

  return {
    signature,
    attestation,
    attestationMint,
    subject,
    referenceId: data.referenceId,
    tokenized,
  };
}

export interface BuildCloseInput {
  authority: TransactionSigner;
  addresses: IssuerAddresses;
  reference: ReferenceAddresses;
  /** Whether the attestation carries a soulbound NFT. Decides which instruction is used. */
  tokenized: boolean;
  attestationTokenAccount: Address;
}

/**
 * Builds the closing instruction. Pure, for the same reason the issue builder is:
 * picking the wrong variant or the wrong account order would only show up as an
 * on-chain failure at the exact moment revocation matters most.
 */
export function buildCloseInstruction(input: BuildCloseInput): Instruction {
  const { authority, addresses, reference, tokenized, attestationTokenAccount } = input;
  const { credential, sasPda, eventAuthority } = addresses;

  return tokenized
    ? getCloseTokenizedAttestationInstruction({
        payer: authority,
        authority,
        credential,
        attestation: reference.attestation,
        attestationMint: reference.attestationMint,
        sasPda,
        attestationTokenAccount,
        eventAuthority,
        tokenProgram: TOKEN_2022_PROGRAM_ADDRESS,
      })
    : getCloseAttestationInstruction({
        payer: authority,
        authority,
        credential,
        attestation: reference.attestation,
        eventAuthority,
      });
}
