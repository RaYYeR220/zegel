/**
 * Zegel SDK — read side.
 *
 * Everything a counterparty needs to act on a reference someone handed them: resolve
 * the name, check the anchor, and (with a grant) open the sealed tiers. Issuing is a
 * separate concern and lives in the app; a verifier should never need write access to
 * anything.
 */

export * from './types.js';
export { canonicalize, canonicalDigest, digestsEqual } from './canonical.js';
export {
  resolveEnvelope,
  decodeEnvelope,
  assertEnvelope,
  ENVELOPE_RECORD_KEY,
  EXTENDED_RESOLVER_INTERFACE_ID,
  DATA_RESOLVER_INTERFACE_ID,
  NoResolverError,
  NoEnvelopeError,
  MalformedEnvelopeError,
  type ResolveOptions,
} from './resolve.js';
export {
  verifyAnchor,
  commitmentFor,
  ZEGEL_ANCHOR_ABI,
  ANCHOR_STATUS,
  type AnchorStatus,
  type AnchorRecord,
  type VerificationReport,
} from './verify.js';
