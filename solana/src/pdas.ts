/**
 * Every address this package touches is derived, never stored.
 *
 * That is the property that makes the anchor portable: a third party who knows
 * only the issuer's authority pubkey and the subject's pubkey can reconstruct the
 * attestation address offline and go look at it, with no index, no API and no
 * cooperation from us.
 *
 *   credential      = [ "credential", authority, CREDENTIAL_NAME ]
 *   schema          = [ "schema", credential, SCHEMA_NAME, SCHEMA_VERSION ]
 *   attestation     = [ "attestation", credential, schema, nonce ]   nonce = subject
 *   schemaMint      = [ "schemaMint", schema ]
 *   attestationMint = [ "attestationMint", attestation ]
 *   sasPda          = [ "sas" ]
 *   eventAuthority  = [ "__event_authority" ]
 */

import {
  deriveAttestationMintPda,
  deriveAttestationPda,
  deriveCredentialPda,
  deriveEventAuthorityAddress,
  deriveSasAuthorityAddress,
  deriveSchemaMintPda,
  deriveSchemaPda,
} from 'sas-lib';
import {
  ASSOCIATED_TOKEN_PROGRAM_ADDRESS,
  TOKEN_2022_PROGRAM_ADDRESS,
  findAssociatedTokenPda,
} from '@solana-program/token-2022';
import type { Address } from '@solana/kit';
import { CREDENTIAL_NAME, SCHEMA_NAME, SCHEMA_VERSION } from './constants.ts';

export { ASSOCIATED_TOKEN_PROGRAM_ADDRESS, TOKEN_2022_PROGRAM_ADDRESS };

/** Addresses that depend only on the issuer, so they are the same for every reference. */
export interface IssuerAddresses {
  authority: Address;
  credential: Address;
  schema: Address;
  schemaMint: Address;
  sasPda: Address;
  eventAuthority: Address;
}

/** Addresses for one (issuer, subject) pair. */
export interface ReferenceAddresses {
  attestation: Address;
  attestationMint: Address;
  recipientTokenAccount: Address;
}

export async function deriveIssuerAddresses(authority: Address): Promise<IssuerAddresses> {
  const [credential] = await deriveCredentialPda({ authority, name: CREDENTIAL_NAME });
  const [schema] = await deriveSchemaPda({
    credential,
    name: SCHEMA_NAME,
    version: SCHEMA_VERSION,
  });
  const [schemaMint] = await deriveSchemaMintPda({ schema });
  const [sasPda, eventAuthority] = await Promise.all([
    deriveSasAuthorityAddress(),
    deriveEventAuthorityAddress(),
  ]);
  return { authority, credential, schema, schemaMint, sasPda, eventAuthority };
}

export async function deriveReferenceAddresses(
  issuer: Pick<IssuerAddresses, 'credential' | 'schema'>,
  subject: Address,
): Promise<ReferenceAddresses> {
  const [attestation] = await deriveAttestationPda({
    credential: issuer.credential,
    schema: issuer.schema,
    nonce: subject,
  });
  const [attestationMint] = await deriveAttestationMintPda({ attestation });
  const [recipientTokenAccount] = await findAssociatedTokenPda({
    mint: attestationMint,
    owner: subject,
    tokenProgram: TOKEN_2022_PROGRAM_ADDRESS,
  });
  return { attestation, attestationMint, recipientTokenAccount };
}
