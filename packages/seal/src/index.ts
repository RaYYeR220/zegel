/**
 * `@zegel/seal` — the access-control layer.
 *
 * Zegel's confidentiality is Swarm's Access Control Trie, not the ENS gateway. The
 * gateway serves a public envelope that leaks nothing but existence; this package
 * is what makes the private part actually private, and what makes revocation an
 * observable event rather than a promise.
 *
 * Read the README before wiring this up — in particular the sections on
 * forward-only revocation and on what the gateway operator can see.
 */

export {
  DEFAULT_NODE_URL,
  NULL_STAMP_HEX,
  SWARM_GATEWAY_URL,
  backendEnvDefaults,
  connectBackend,
  type BackendKind,
  type ConfidentialityModel,
  type ConnectBackendOptions,
  type SealCapabilities,
  type SwarmBackend,
} from './backend.js';

export {
  SealClient,
  createSealClient,
  type GranteeListReceipt,
  type SealClientOptions,
  type SealOptions,
  type UnsealOptions,
} from './client.js';

export {
  SEAL_ENVELOPE_SCHEMA,
  decodeEnvelope,
  encodeEnvelope,
  encodeEnvelopeObject,
  makeEnvelope,
  type EncodeEnvelopeInput,
  type SealEnvelope,
  type SealTierNumber,
} from './envelope.js';

export {
  BackendUnreachableError,
  EnvelopeError,
  GranteeManagementUnavailableError,
  InvalidPublicKeyError,
  PostageUnavailableError,
  PublisherUnknownError,
  SealError,
  httpStatusOf,
  isNotFound,
  type SealErrorCode,
} from './errors.js';

export {
  allKeepers,
  fileKeeper,
  memoryKeeper,
  readKeptReceipts,
  type MemoryKeeper,
  type ReceiptKeeper,
} from './keeper.js';

export {
  BLOCK_TIME_SECONDS,
  DEMO_BATCH_DEPTH,
  MIN_BATCH_DEPTH,
  amountForDuration,
  batchCostPlur,
  ensureUsableBatch,
  plurToBzz,
  quoteBatch,
  readStoragePrice,
  waitForUsableBatch,
  type BatchQuote,
  type EnsureBatchOptions,
  type StoragePrice,
  type SwarmNetwork,
  type WaitForUsableOptions,
} from './postage.js';

export {
  COMPRESSED_PUBLIC_KEY_PATTERN,
  eip191Hash,
  granteeAddress,
  granteeFromPrivateKey,
  granteeFromSignedMessage,
  granteeFromUncompressed,
  granteePublicKey,
  isGranteePublicKey,
  looksLikeCompressedPublicKey,
  normaliseGrantees,
  tryGranteePublicKey,
  type GranteePublicKey,
} from './pubkey.js';

export {
  MIN_GRANTEE_PATCH_INTERVAL_MS,
  PatchQueue,
  type DepthListener,
  type PatchQueueOptions,
} from './queue.js';

export {
  coordinatesFromTier,
  coordinatesOf,
  isReadable,
  toSealedTier,
  type GranteeOutcome,
  type SealCoordinates,
  type SealReceipt,
} from './receipt.js';

export {
  historyAddress,
  isHistoryAddress,
  isSwarmReference,
  swarmReference,
  type HistoryAddress,
  type SwarmReference,
} from './refs.js';
