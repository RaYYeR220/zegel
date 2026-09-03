/** Public result shapes. */

import type { Address, Signature } from '@solana/kit';
import type { ReferenceAttestationData } from './schema.ts';

/**
 * The verification verdict.
 *
 * Precedence, most specific first, so an answer never hides a worse one behind a
 * milder one:
 *
 *   1. not-found            nothing was ever anchored at this address
 *   2. revoked              the attestation existed and was closed by the issuer
 *   3. reference-mismatch   a different reference is anchored for this subject
 *   4. commitment-mismatch  the claims presented are not the claims that were anchored
 *   5. schema-paused        the issuer has suspended the whole schema
 *   6. expired              past its expiry
 *   7. valid
 *
 * `commitment-mismatch` deliberately outranks `expired` and `schema-paused`: a
 * tampered claim set has to fail as a tampered claim set whatever the clock says.
 */
export type ReferenceStatus =
  | 'valid'
  | 'expired'
  | 'revoked'
  | 'not-found'
  | 'commitment-mismatch'
  | 'reference-mismatch'
  | 'schema-paused';

/**
 * How a revocation was observed. Everything here is checkable by a third party.
 *
 * Only produced when a close instruction to the attestation program was actually found
 * in the transaction. An unexplained transaction at the address proves nothing —
 * attestation addresses are derivable by anyone, so anyone can put traffic there.
 */
export interface RevocationEvidence {
  /** The transaction that closed the attestation. */
  signature: string;
  slot: number;
  /** Unix seconds, when the RPC reports it. */
  blockTime: number | null;
  /** The close instruction identified in that transaction, top-level or via CPI. */
  instruction: 'CloseAttestation' | 'CloseTokenizedAttestation';
}

export interface VerifyResult {
  status: ReferenceStatus;
  /** Prose suitable for a CLI or a UI badge. */
  detail: string;
  subject: Address;
  /** The reference id that was asked about. */
  referenceId: string;
  attestation: Address;
  credential: Address;
  schema: Address;
  attestationMint: Address;
  /** Present whenever the attestation account was readable. */
  onchain?: ReferenceAttestationData;
  /** The token account holding the soulbound NFT, when the attestation is tokenized. */
  tokenAccount?: Address;
  /** Whether the issuer has paused the schema. */
  schemaPaused: boolean;
  /**
   * False when the on-chain schema no longer matches the layout this package encodes.
   * Also false when there is no schema on chain at all, in which case `status` is
   * `not-found` and `detail` says so.
   */
  schemaMatchesExpected: boolean;
  /** Present when `status` is `revoked`. */
  revocation?: RevocationEvidence;
  /** ISO timestamp of the check itself. */
  checkedAt: string;
}

export interface IssuerSetupResult {
  /** Which accounts this call had to create. All false on a second run. */
  created: { credential: boolean; schema: boolean; schemaMint: boolean };
  signature: Signature | null;
}

export interface IssueResult {
  signature: Signature;
  attestation: Address;
  attestationMint: Address;
  recipientTokenAccount: Address;
  credential: Address;
  schema: Address;
  subject: Address;
  data: ReferenceAttestationData;
}

export interface RevokeResult {
  signature: Signature;
  attestation: Address;
  attestationMint: Address;
  subject: Address;
  /** The reference that was anchored there, read back before the close. */
  referenceId: string;
  tokenized: boolean;
}
