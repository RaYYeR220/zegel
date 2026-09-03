/**
 * Issue a reference anchor.
 *
 * Always tokenized. A bare attestation PDA is a row in an account the issuer
 * controls; the tokenized variant additionally mints a Token-2022 NFT to the
 * subject carrying NonTransferable, PermanentDelegate and MintCloseAuthority, all
 * held by the SAS program authority. Those three extensions are what make
 * revocation a state change anyone can observe rather than a claim we make: the
 * subject cannot move the token away from the address a verifier checks, and the
 * issuer can burn and close it.
 */

import { address, type Address, type Instruction, type TransactionSigner } from '@solana/kit';
import { getMintSize } from '@solana-program/token-2022';
import type { Schema } from 'sas-lib';
import { fetchMaybeAttestation, fetchSchema, getCreateTokenizedAttestationInstruction } from 'sas-lib';
import {
  DEFAULT_TIER_COUNT,
  TOKEN_NAME,
  TOKEN_SYMBOL,
  TOKEN_URI,
} from './constants.ts';
import type { ZegelIssuerContext } from './context.ts';
import { AttestationExistsError, IssuerNotInitializedError } from './errors.ts';
import { normalizeHex32 } from './hex.ts';
import {
  ASSOCIATED_TOKEN_PROGRAM_ADDRESS,
  deriveReferenceAddresses,
  type IssuerAddresses,
  type ReferenceAddresses,
  TOKEN_2022_PROGRAM_ADDRESS,
} from './pdas.ts';
import { accountExists, sendInstructions } from './rpc.ts';
import {
  assertSchemaMatchesExpected,
  decodeReferenceData,
  encodeReferenceData,
  type ReferenceAttestationData,
} from './schema.ts';
import type { IssueResult } from './types.ts';

/** Anything that can name a moment. Normalised to unix seconds. */
export type ExpiryInput = number | bigint | Date | string;

export interface IssueOptions {
  issuer: ZegelIssuerContext;
  /** The subject's Solana pubkey. Used verbatim as the attestation nonce. */
  subject: Address | string;
  referenceId: string;
  /** sha256 over the canonical ClaimSet, 32-byte hex. */
  commitment: string;
  expiresAt: ExpiryInput;
  derivationId: string;
  /** How many sealed disclosure tiers back this reference. */
  tierCount?: number;
  /** Token-2022 metadata written into the mint. Defaults are in `constants.ts`. */
  token?: { name?: string; symbol?: string; uri?: string };
}

export function toUnixSeconds(value: ExpiryInput): bigint {
  if (typeof value === 'bigint') return value;
  if (value instanceof Date) return BigInt(Math.floor(value.getTime() / 1000));
  if (typeof value === 'number') {
    // Tolerate milliseconds: anything past year 33658 in seconds is certainly a ms value.
    return BigInt(Math.floor(value > 1e12 ? value / 1000 : value));
  }
  if (/^\d+$/.test(value)) return toUnixSeconds(Number(value));
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) throw new TypeError(`cannot read an expiry from ${JSON.stringify(value)}`);
  return BigInt(Math.floor(parsed / 1000));
}

export async function issue(options: IssueOptions): Promise<IssueResult> {
  const { issuer, tierCount = DEFAULT_TIER_COUNT, token = {} } = options;
  const { rpc, authority, addresses } = issuer;
  const { credential, schema, schemaMint } = addresses;

  const subject = address(String(options.subject));

  const data: ReferenceAttestationData = {
    referenceId: normalizeHex32('referenceId', options.referenceId),
    commitment: normalizeHex32('commitment', options.commitment),
    expiresAt: toUnixSeconds(options.expiresAt),
    derivationId: normalizeHex32('derivationId', options.derivationId),
    tierCount,
  };

  if (!(await accountExists(rpc, schemaMint))) {
    throw new IssuerNotInitializedError('schema mint', schemaMint);
  }

  // Encode against the live schema, not a local assumption: if the on-chain layout
  // ever drifts the attestation would still be written, just meaning something else.
  const schemaAccount = await fetchSchema(rpc, schema);
  assertSchemaMatchesExpected(schemaAccount.data);

  const { attestation, attestationMint, recipientTokenAccount } = await deriveReferenceAddresses(
    { credential, schema },
    subject,
  );

  const existing = await fetchMaybeAttestation(rpc, attestation);
  if (existing.exists) {
    const current = decodeReferenceData(
      Uint8Array.from(existing.data.data),
      schemaAccount.data,
    );
    throw new AttestationExistsError(attestation, current.referenceId);
  }

  const instruction = buildIssueInstruction({
    authority,
    addresses,
    reference: { attestation, attestationMint, recipientTokenAccount },
    subject,
    schemaAccount: schemaAccount.data,
    data,
    token: {
      name: token.name ?? TOKEN_NAME,
      symbol: token.symbol ?? TOKEN_SYMBOL,
      uri: token.uri ?? TOKEN_URI,
    },
  });

  const signature = await sendInstructions(rpc, authority, [instruction], {
    computeUnitLimit: 400_000,
    ...issuer.sendOptions,
  });

  return {
    signature,
    attestation,
    attestationMint,
    recipientTokenAccount,
    credential,
    schema,
    subject,
    data,
  };
}

export interface BuildIssueInput {
  /** Must be one of the credential's authorized signers. Also the fee payer. */
  authority: TransactionSigner;
  addresses: IssuerAddresses;
  reference: ReferenceAddresses;
  subject: Address;
  /** The schema account the data is encoded against. */
  schemaAccount: Schema;
  data: ReferenceAttestationData;
  token: { name: string; symbol: string; uri: string };
}

/**
 * Builds the `CreateTokenizedAttestation` instruction. Pure — no RPC, no clock — so
 * the account list, the mint sizing and the Borsh payload can be asserted without a
 * cluster, which is the part of this package a bad byte would break silently.
 */
export function buildIssueInstruction(input: BuildIssueInput): Instruction {
  const { authority, addresses, reference, subject, schemaAccount, data, token } = input;
  const { credential, schema, schemaMint, sasPda } = addresses;
  const { attestation, attestationMint, recipientTokenAccount } = reference;

  // The client sizes the mint; the program allocates exactly this many bytes. The
  // extension list has to match what the program writes or the account is short.
  const mintAccountSpace = getMintSize([
    { __kind: 'GroupMemberPointer', authority: sasPda, memberAddress: attestationMint },
    { __kind: 'NonTransferable' },
    { __kind: 'MetadataPointer', authority: sasPda, metadataAddress: attestationMint },
    { __kind: 'PermanentDelegate', delegate: sasPda },
    { __kind: 'MintCloseAuthority', closeAuthority: sasPda },
    {
      __kind: 'TokenMetadata',
      updateAuthority: sasPda,
      mint: attestationMint,
      name: token.name,
      symbol: token.symbol,
      uri: token.uri,
      additionalMetadata: new Map([
        ['attestation', attestation as string],
        ['schema', schema as string],
      ]),
    },
    { __kind: 'TokenGroupMember', group: schemaMint, mint: attestationMint, memberNumber: 1 },
  ]);

  return getCreateTokenizedAttestationInstruction({
    payer: authority,
    authority,
    credential,
    schema,
    attestation,
    schemaMint,
    attestationMint,
    sasPda,
    recipient: subject,
    recipientTokenAccount,
    nonce: subject,
    // Mirrored deliberately: `expiry` is what the program enforces, `expiresAt`
    // inside the Borsh payload is what a verifier reading only the data can see.
    expiry: data.expiresAt,
    data: encodeReferenceData(data, schemaAccount),
    name: token.name,
    uri: token.uri,
    symbol: token.symbol,
    mintAccountSpace,
    tokenProgram: TOKEN_2022_PROGRAM_ADDRESS,
    associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ADDRESS,
  });
}
