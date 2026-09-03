/**
 * `@zegel/solana` — the Solana Attestation Service anchor for a Zegel reference.
 *
 * A Zegel reference lives off-chain: an ACT-sealed evidence bundle on Swarm,
 * discovered through an ENS name. This package anchors its public commitment on
 * Solana so the credential is portable off Ethereum and revocable by the issuer,
 * and so a third party can check both facts without asking us for anything.
 */

export {
  ACCOUNT_DISCRIMINATOR,
  CLUSTERS,
  CREDENTIAL_NAME,
  DEFAULT_TIER_COUNT,
  explorerAccountUrl,
  SAS_PROGRAM_ADDRESS,
  SCHEMA_DESCRIPTION,
  SCHEMA_NAME,
  SCHEMA_VERSION,
  TOKEN_NAME,
  TOKEN_SYMBOL,
  TOKEN_URI,
  type ClusterName,
} from './constants.ts';

export {
  assertSchemaMatchesExpected,
  decodeFieldNames,
  decodeReferenceData,
  encodeFieldNames,
  encodeReferenceData,
  localSchemaAccount,
  normalizeReferenceData,
  SchemaDataType,
  SchemaDriftError,
  schemaMatchesExpected,
  ZEGEL_SCHEMA_DATA_SIZE,
  ZEGEL_SCHEMA_FIELDS,
  ZEGEL_SCHEMA_LAYOUT,
  type ReferenceAttestationData,
} from './schema.ts';

export {
  ASSOCIATED_TOKEN_PROGRAM_ADDRESS,
  deriveIssuerAddresses,
  deriveReferenceAddresses,
  TOKEN_2022_PROGRAM_ADDRESS,
  type IssuerAddresses,
  type ReferenceAddresses,
} from './pdas.ts';

export { bytesToHex32, hex32ToBytes, hexEqual, HexError, normalizeHex32 } from './hex.ts';

export {
  accountExists,
  confirmSignature,
  createRpc,
  getBalanceSol,
  sendInstructions,
  toSigner,
  type KeypairInput,
  type SendOptions,
  type SolanaRpc,
} from './rpc.ts';

export { loadKeypairFile } from './keypair.ts';

export { createIssuer, setupIssuer, type CreateIssuerOptions, type ZegelIssuer } from './issuer.ts';
export type { ZegelIssuerContext } from './context.ts';

export { issue, toUnixSeconds, type ExpiryInput, type IssueOptions } from './issue.ts';
export { close, revoke, type CloseOptions, type RevokeOptions } from './revoke.ts';
export { verify, type VerifyOptions } from './verify.ts';
export { issuerStatus, type IssuerStatus } from './status.ts';

export {
  AttestationExistsError,
  AttestationNotExpiredError,
  AttestationNotFoundError,
  ConfirmationTimeoutError,
  IssuerNotInitializedError,
  ReferenceMismatchError,
  SendFailedError,
  TransactionFailedError,
  ZegelSolanaError,
} from './errors.ts';

export type {
  IssueResult,
  IssuerSetupResult,
  ReferenceStatus,
  RevocationEvidence,
  RevokeResult,
  VerifyResult,
} from './types.ts';
