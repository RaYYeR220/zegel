/**
 * Fixed identifiers for the Zegel attestation surface.
 *
 * Credential name, schema name and schema version are PDA seeds. Changing any of
 * them moves every address in this package, so they are consensus: a verifier
 * that derives addresses from different constants is looking at a different
 * credential entirely.
 */

import { SOLANA_ATTESTATION_SERVICE_PROGRAM_ADDRESS } from 'sas-lib';

export const SAS_PROGRAM_ADDRESS = SOLANA_ATTESTATION_SERVICE_PROGRAM_ADDRESS;

/**
 * Byte 0 of each SAS account.
 *
 * These are NOT sas-lib's `SolanaAttestationServiceAccount` enum, which is a Codama
 * account *index* (Attestation=0, Credential=1, Schema=2) and does not match what the
 * program writes. Verified by decoding live devnet accounts: filtering the program's
 * accounts on byte 0 yields Credentials at 0, Schemas at 1 and Attestations at 2.
 * Anyone writing a `memcmp` filter against SAS needs these, not the enum.
 */
export const ACCOUNT_DISCRIMINATOR = {
  credential: 0,
  schema: 1,
  attestation: 2,
} as const;

/** Credential seed. Only the first 32 bytes are used by the PDA derivation. */
export const CREDENTIAL_NAME = 'zegel';

/** Schema seed, scoped to the credential above. */
export const SCHEMA_NAME = 'reference';

/**
 * Schema version. Bumping this creates a new schema PDA and leaves attestations
 * under the old one untouched — the only safe way to change the field layout.
 */
export const SCHEMA_VERSION = 1;

export const SCHEMA_DESCRIPTION =
  'Zegel private financial reference: public commitment, expiry and derivation pin. Carries no claim contents.';

/** Soulbound Token-2022 NFT metadata written into the attestation mint. */
export const TOKEN_NAME = 'Zegel Reference';
export const TOKEN_SYMBOL = 'ZEGEL';

/**
 * Self-contained by design. A hosted metadata JSON would add a server that can go
 * dark without any on-chain change, which is exactly the dependency this credential
 * exists to remove — so the URI carries its own payload. The authoritative record is
 * still the attestation account plus the ENS envelope. Override per issuance if a
 * particular wallet needs something richer to render.
 */
export const TOKEN_URI =
  'data:application/json,{"name":"Zegel Reference","description":"Revocable anchor for a sealed private financial reference."}';

/** Default number of sealed disclosure tiers per reference (claims + evidence). */
export const DEFAULT_TIER_COUNT = 2;

export const CLUSTERS = {
  devnet: {
    rpcUrl: 'https://api.devnet.solana.com',
    explorerSuffix: '?cluster=devnet',
  },
  'mainnet-beta': {
    rpcUrl: 'https://api.mainnet-beta.solana.com',
    explorerSuffix: '',
  },
} as const;

export type ClusterName = keyof typeof CLUSTERS;

export function explorerAccountUrl(addressOrSig: string, cluster: ClusterName): string {
  const kind = addressOrSig.length > 44 ? 'tx' : 'address';
  return `https://explorer.solana.com/${kind}/${addressOrSig}${CLUSTERS[cluster].explorerSuffix}`;
}
