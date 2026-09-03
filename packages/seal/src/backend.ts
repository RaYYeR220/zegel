import { Bee, NULL_STAMP, SWARM_GATEWAY_URL } from '@ethersphere/bee-js';

import { BackendUnreachableError, isNotFound } from './errors.js';
import { ensureUsableBatch, type EnsureBatchOptions, type SwarmNetwork } from './postage.js';
import { granteePublicKey, type GranteePublicKey } from './pubkey.js';

export { SWARM_GATEWAY_URL };

/** Bee's default local API port. */
export const DEFAULT_NODE_URL = 'http://localhost:1633';

export type BackendKind = 'gateway' | 'node';

/**
 * How strong the confidentiality actually is on this backend.
 *
 * `key-bound` — the ACT publisher is a node we control. Decryption happens on the
 * grantee's own Bee node with the grantee's own key, so possession of the three
 * ACT coordinates is not sufficient to read.
 *
 * `obscurity` — the publisher is somebody else's node (the public gateway). It
 * holds the publisher private key and will decrypt for anyone who presents the
 * reference, the history address and the publisher key. That is secrecy of three
 * out-of-band values, not cryptographic access control, and it is labelled as such
 * rather than being quietly counted as privacy.
 */
export type ConfidentialityModel = 'key-bound' | 'obscurity';

export interface SealCapabilities {
  readonly kind: BackendKind;
  readonly url: string;
  /** `/grantee` is only exposed by a real Bee node. Grant and revoke need it. */
  readonly canManageGrantees: boolean;
  /** Whether `/chainstate` and `/stamps` are reachable, i.e. real postage is possible. */
  readonly canManagePostage: boolean;
  /** Whether an ACT publisher key is known, i.e. whether any read can be attempted. */
  readonly canUnseal: boolean;
  /** True when uploading against the all-zeros batch — no stamp, no tokens, no TTL guarantee. */
  readonly usesNullStamp: boolean;
  readonly confidentiality: ConfidentialityModel;
  /** Present when the node reported it. */
  readonly beeMode?: string;
  /** Human-readable reasons a capability is off, for a UI to show verbatim. */
  readonly limitations: readonly string[];
}

export interface SwarmBackend {
  readonly bee: Bee;
  readonly caps: SealCapabilities;
  /** The batch every upload is stamped with. */
  readonly batchId: string;
  /** ACT publisher, or null when it could not be discovered. */
  readonly publisher: GranteePublicKey | null;
}

export interface ConnectBackendOptions {
  /** `auto` prefers a reachable node and falls back to the gateway. */
  kind?: BackendKind | 'auto';
  /** Overrides the URL for the chosen kind. */
  url?: string;
  network?: SwarmNetwork;
  /** Postage batch to stamp uploads with. Ignored on the gateway, which uses the null stamp. */
  batchId?: string;
  postage?: Omit<EnsureBatchOptions, 'batchId'>;
  /**
   * ACT publisher key, when the backend cannot report its own.
   * Supplying a wrong key here does not fail loudly — every read simply 404s.
   */
  actPublisher?: string;
  /** How long to wait when probing for a node in `auto` mode. */
  probeTimeoutMs?: number;
  onProgress?: (message: string) => void;
}

/** Reads the environment the way the rest of the monorepo does. */
export function backendEnvDefaults(env: Record<string, string | undefined> = process.env): {
  gatewayUrl: string;
  nodeUrl: string;
  batchId: string | undefined;
  actPublisher: string | undefined;
} {
  return {
    gatewayUrl: env.SWARM_GATEWAY_URL ?? SWARM_GATEWAY_URL,
    nodeUrl: env.ZEGEL_BEE_URL ?? env.BEE_API_URL ?? DEFAULT_NODE_URL,
    batchId: env.ZEGEL_POSTAGE_BATCH_ID,
    actPublisher: env.ZEGEL_ACT_PUBLISHER,
  };
}

/** The all-zeros batch the public gateway accepts. */
export const NULL_STAMP_HEX = NULL_STAMP.toHex();

/**
 * Connects to whichever Swarm API is available and reports honestly what it can do.
 *
 * Nothing here throws because a capability is missing — that is what `caps` is for.
 * It throws only when the chosen endpoint does not answer at all.
 */
export async function connectBackend(options: ConnectBackendOptions = {}): Promise<SwarmBackend> {
  const env = backendEnvDefaults();
  const report = options.onProgress ?? (() => undefined);
  const kind = await resolveKind(options, env, report);

  return kind === 'node'
    ? connectNode(options.url ?? env.nodeUrl, options, env, report)
    : connectGateway(options.url ?? env.gatewayUrl, options, env, report);
}

async function resolveKind(
  options: ConnectBackendOptions,
  env: ReturnType<typeof backendEnvDefaults>,
  report: (message: string) => void,
): Promise<BackendKind> {
  if (options.kind && options.kind !== 'auto') return options.kind;

  const nodeUrl = options.url ?? env.nodeUrl;
  const reachable = await probeNode(nodeUrl, options.probeTimeoutMs ?? 1_500);
  if (reachable) {
    report(`found a Bee node at ${nodeUrl}`);
    return 'node';
  }

  report(`no Bee node at ${nodeUrl}, falling back to the public gateway (grant/revoke unavailable)`);
  return 'gateway';
}

/**
 * Is there a Bee node here that is not just a gateway?
 *
 * `/gateway` answering `{"gateway":true}` is the public gateway advertising itself;
 * treating that as a node would promise grantee management that 404s later.
 */
async function probeNode(url: string, timeoutMs: number): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const health = await fetch(new URL('/health', url), { signal: controller.signal });
    if (!health.ok) return false;

    const gateway = await fetch(new URL('/gateway', url), { signal: controller.signal }).catch(() => null);
    if (gateway?.ok) {
      const body = (await gateway.json().catch(() => null)) as { gateway?: unknown } | null;
      if (body?.gateway === true) return false;
    }
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function connectNode(
  url: string,
  options: ConnectBackendOptions,
  env: ReturnType<typeof backendEnvDefaults>,
  report: (message: string) => void,
): Promise<SwarmBackend> {
  const bee = new Bee(url, { network: options.network ?? 'gnosis' });

  const connected = await bee.connectivity.isConnected().catch(() => false);
  if (!connected) throw new BackendUnreachableError(url);

  const publisher = await resolvePublisher(bee, options.actPublisher ?? env.actPublisher);
  const beeMode = await bee.status
    .getNodeInfo()
    .then((info) => info.beeMode as string)
    .catch(() => undefined);

  const limitations: string[] = [];
  if (!publisher) {
    limitations.push('the node did not report a public key, so sealed content cannot be read back');
  }
  if (beeMode === 'ultra-light') {
    limitations.push('an ultra-light node cannot upload; sealing will fail until it is switched to light');
  }

  const configuredBatch = options.batchId ?? env.batchId;
  const batchId = await ensureUsableBatch(bee, {
    ...options.postage,
    ...(configuredBatch ? { batchId: configuredBatch } : {}),
    onProgress: report,
  });

  return {
    bee,
    batchId,
    publisher,
    caps: {
      kind: 'node',
      url,
      canManageGrantees: true,
      canManagePostage: true,
      canUnseal: publisher !== null,
      usesNullStamp: false,
      confidentiality: 'key-bound',
      ...(beeMode ? { beeMode } : {}),
      limitations,
    },
  };
}

async function connectGateway(
  url: string,
  options: ConnectBackendOptions,
  env: ReturnType<typeof backendEnvDefaults>,
  report: (message: string) => void,
): Promise<SwarmBackend> {
  const bee = new Bee(url, { network: options.network ?? 'gnosis' });

  const healthy = await bee.status
    .getHealth()
    .then(() => true)
    .catch(async () => {
      // The gateway answers /health with the string "OK", which bee-js fails to parse.
      const raw = await fetch(new URL('/health', url)).catch(() => null);
      return raw?.ok === true;
    });
  if (!healthy) throw new BackendUnreachableError(url);

  // Verified 2026-09-03: the public gateway 404s /addresses, so its publisher key
  // is not discoverable. An explicitly configured key is the only way to read back.
  const publisher = await resolvePublisher(bee, options.actPublisher ?? env.actPublisher);

  const limitations = [
    'POST /grantee is not exposed here: access cannot be granted or revoked, only sealed to the publisher',
    'GET /chainstate and /stamps are not exposed here: uploads use the all-zeros batch and carry no paid TTL',
    'the gateway operator holds the ACT publisher key, so it can decrypt anything sealed through it',
  ];
  if (!publisher) {
    limitations.push(
      'GET /addresses is not exposed here, so the publisher key is unknown and sealed content cannot be read back through this backend',
    );
  }

  report(`using the public gateway at ${url} with the null stamp; grant/revoke are unavailable`);

  return {
    bee,
    batchId: NULL_STAMP_HEX,
    publisher,
    caps: {
      kind: 'gateway',
      url,
      canManageGrantees: false,
      canManagePostage: false,
      canUnseal: publisher !== null,
      usesNullStamp: true,
      confidentiality: 'obscurity',
      limitations,
    },
  };
}

/**
 * Resolves the ACT publisher key.
 *
 * `publicKey`, never `pssPublicKey`. They are different keys on the same node and
 * ACT derives its session key from the former; substituting the latter produces a
 * grant that looks fine and decrypts nothing.
 */
async function resolvePublisher(bee: Bee, configured: string | undefined): Promise<GranteePublicKey | null> {
  if (configured) return granteePublicKey(configured);

  try {
    const addresses = await bee.connectivity.getNodeAddresses();
    return granteePublicKey(addresses.publicKey.toCompressedHex());
  } catch (cause) {
    if (isNotFound(cause)) return null;
    return null;
  }
}
