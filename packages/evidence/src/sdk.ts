/**
 * Single import point for the shared wire contract.
 *
 * Everything that crosses a module boundary — the types and the one canonical
 * digest — is defined in `@zegel/sdk`. Funnelling it through this file means the
 * rest of the package never reaches across the workspace directly, and there is
 * exactly one place to change when the sdk package gains a manifest.
 */
export { canonicalDigest, canonicalize, digestsEqual } from '@zegel/sdk/canonical';
export {
  BUNDLE_SCHEMA,
  CLAIMS_SCHEMA,
  ENVELOPE_SCHEMA,
} from '@zegel/sdk/types';
export type {
  ChainId,
  Claim,
  ClaimOp,
  ClaimSet,
  ClaimUnit,
  ControlProof,
  EvidenceBundle,
  EvidenceSource,
  TimeWindow,
} from '@zegel/sdk/types';
