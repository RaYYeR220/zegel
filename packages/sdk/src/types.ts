/**
 * Zegel wire types.
 *
 * These are the hard interface between the evidence engine, the sealing layer,
 * the resolver gateway and the app. Anything that crosses a module boundary or
 * gets hashed into a commitment is defined here and nowhere else.
 */

export const CLAIMS_SCHEMA = 'zegel.claims.v1' as const;
export const BUNDLE_SCHEMA = 'zegel.bundle.v1' as const;
export const ENVELOPE_SCHEMA = 'zegel.envelope.v1' as const;

/** Chain identifiers follow Mobula's format: `evm:1`, `evm:8453`, `solana`. */
export type ChainId = string;

export type ClaimOp = 'gte' | 'lte' | 'between' | 'eq';
export type ClaimUnit = 'usd' | 'count' | 'ratio' | 'days' | 'score';

/**
 * A single assertion about the subject's on-chain history.
 *
 * Claims are derived from live upstream data, never supplied by the subject.
 * `actual` is populated only in the full evidence bundle (tier 2); a tier-1
 * reader learns whether the threshold was met and nothing more.
 */
export interface Claim {
  /** Stable slug, e.g. `realized-pnl-usd-90d`. Same id across tiers. */
  id: string;
  /** Plain-English rendering, safe to show a reader who has never used a block explorer. */
  statement: string;
  op: ClaimOp;
  threshold: number | readonly [number, number];
  unit: ClaimUnit;
  passed: boolean;
  /** Tier 2 only. */
  actual?: number;
  /** Indices into `EvidenceBundle.sources` that this claim was computed from. */
  sources: readonly number[];
}

export interface TimeWindow {
  /** ISO 8601. */
  from: string;
  /** ISO 8601. */
  to: string;
}

/**
 * Tier 1 payload — what a claims-grantee can decrypt.
 *
 * Deliberately contains no address and no raw upstream data: a tier-1 reader
 * learns which thresholds were met, over what window, on which chains.
 */
export interface ClaimSet {
  schema: typeof CLAIMS_SCHEMA;
  /** 32-byte hex, `0x`-prefixed. */
  referenceId: string;
  chains: readonly ChainId[];
  window: TimeWindow;
  claims: readonly Claim[];
  /** ISO 8601. */
  derivedAt: string;
  /**
   * Digest of the derivation source and its parameters. Pins reproducibility:
   * two bundles with the same `derivationId` were scored by the same rules.
   */
  derivationId: string;
}

/**
 * One verbatim upstream response.
 *
 * `digest` is always present so a tier-1 reader can see how many sources backed
 * a claim without seeing them. `body` appears at tier 2 only, which is what makes
 * the bundle re-derivable by the grantee rather than merely attested by us.
 */
export interface EvidenceSource {
  index: number;
  /** e.g. `GET /2/wallet/positions-history`. */
  endpoint: string;
  params: Readonly<Record<string, string | number | boolean>>;
  /** ISO 8601. */
  fetchedAt: string;
  /** sha256 of the canonical JSON body. */
  digest: string;
  /** Tier 2 only. */
  body?: unknown;
  /**
   * Set when the upstream failed and the source could not be collected.
   * Claims depending on an unavailable source are omitted entirely — we never
   * substitute a default and never emit a claim we could not compute.
   */
  unavailable?: { reason: string; status?: number };
}

/** Proof that the subject controls the wallet the evidence describes. */
export interface ControlProof {
  /** The exact string that was signed. */
  message: string;
  /** EIP-191 personal_sign signature. */
  signature: string;
  /** Address recovered from the signature; must equal `subject.address`. */
  signer: string;
}

/**
 * Tier 2 payload — the full evidence, including the address.
 *
 * A grantee at this tier can re-run the derivation against `sources[].body` and
 * confirm every claim without trusting the issuer.
 */
export interface EvidenceBundle {
  schema: typeof BUNDLE_SCHEMA;
  referenceId: string;
  subject: { address: string; chains: readonly ChainId[] };
  window: TimeWindow;
  sources: readonly EvidenceSource[];
  /** Same ids as the tier-1 `ClaimSet`, with `actual` populated. */
  claims: readonly Claim[];
  derivedAt: string;
  derivationId: string;
  controlProof: ControlProof;
}

/** Where a sealed tier lives on Swarm and who can open it. */
export interface SealedTier {
  tier: 1 | 2;
  /** Swarm reference, hex. Access-controlled — an un-granted read returns 404. */
  swarmRef: string;
  /** Losing this permanently and irrecoverably loses access to the content. */
  actHistoryAddress: string;
  /** Compressed secp256k1 public key of the ACT publisher, 66 hex chars. */
  actPublisher: string;
}

export interface BaseAnchor {
  chainId: 8453;
  contract: string;
  txHash: string;
}

export interface SolanaAnchor {
  /** Attestation PDA. */
  attestation: string;
  schema: string;
  credential: string;
}

/**
 * What the ENS resolver serves under ENSIP-24 `data()`.
 *
 * This is public by construction. It reveals that a reference exists, when it
 * expires, and where to look — and nothing about its contents. The commitment
 * lets anyone check later that the claims they were shown are the claims that
 * were sealed.
 */
export interface SealedEnvelope {
  schema: typeof ENVELOPE_SCHEMA;
  referenceId: string;
  /** sha256 over the canonical `ClaimSet`. */
  commitment: string;
  /** ISO 8601. */
  issuedAt: string;
  /** ISO 8601. */
  expiresAt: string;
  tiers: readonly SealedTier[];
  anchors: {
    base?: BaseAnchor;
    solana?: SolanaAnchor;
  };
  /** Revocation is observable here without decrypting anything. */
  revocationHint: { contract: string; chainId: number };
}

/** Returned instead of a payload when the caller holds no grant. */
export interface NotGranted {
  granted: false;
  /** Swarm answers an un-granted read with 404, indistinguishable from absent. */
  reason: 'not-granted-or-absent';
}

export type Unsealed<T> = { granted: true; payload: T } | NotGranted;
