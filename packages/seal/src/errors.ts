/**
 * Errors raised by the sealing layer.
 *
 * Every failure mode that a caller is expected to handle has its own class and a
 * stable `code`. The one deliberate exception is an un-granted read: that is a
 * normal, expected outcome and is returned as a typed `NotGranted` value rather
 * than thrown — see `unseal`.
 */

export type SealErrorCode =
  | 'invalid-public-key'
  | 'invalid-envelope'
  | 'grantee-management-unavailable'
  | 'publisher-unknown'
  | 'postage-unavailable'
  | 'backend-unreachable';

export class SealError extends Error {
  readonly code: SealErrorCode;

  constructor(code: SealErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options as ErrorOptions);
    this.code = code;
    this.name = new.target.name;
  }
}

/** A grantee identity was not a valid compressed secp256k1 public key. */
export class InvalidPublicKeyError extends SealError {
  readonly value: string;

  constructor(value: string, detail: string) {
    super('invalid-public-key', `not a compressed secp256k1 public key (${detail}): ${value}`);
    this.value = value;
  }
}

/** Bytes came back from Swarm but were not a Zegel seal envelope. */
export class EnvelopeError extends SealError {
  constructor(detail: string, options?: { cause?: unknown }) {
    super('invalid-envelope', `sealed envelope is malformed: ${detail}`, options);
  }
}

/**
 * The active backend cannot manage a grantee list.
 *
 * `POST /grantee` is not exposed by the public Swarm gateway, so grant/revoke
 * require a Bee node we control. This is thrown rather than silently skipped:
 * a caller that asked to grant access must never believe access was granted.
 */
export class GranteeManagementUnavailableError extends SealError {
  readonly backendUrl: string;

  constructor(backendUrl: string) {
    super(
      'grantee-management-unavailable',
      `the backend at ${backendUrl} does not expose /grantee; grant and revoke need a Bee node ` +
        `(set ZEGEL_BEE_URL, or check caps.canManageGrantees before calling)`,
    );
    this.backendUrl = backendUrl;
  }
}

/**
 * The ACT publisher public key is not known, so no read can be attempted.
 *
 * Distinct from `NotGranted` on purpose. "I could not ask the question" and
 * "I asked and was refused" are different facts and collapsing them would make
 * the privacy claim untestable.
 */
export class PublisherUnknownError extends SealError {
  readonly backendUrl: string;

  constructor(backendUrl: string) {
    super(
      'publisher-unknown',
      `no ACT publisher key for ${backendUrl}: the node did not expose /addresses and none was ` +
        `configured (set actPublisher or ZEGEL_ACT_PUBLISHER)`,
    );
    this.backendUrl = backendUrl;
  }
}

/** No usable postage batch could be found or created. */
export class PostageUnavailableError extends SealError {
  constructor(detail: string, options?: { cause?: unknown }) {
    super('postage-unavailable', `no usable postage batch: ${detail}`, options);
  }
}

/** The configured Bee endpoint did not answer. */
export class BackendUnreachableError extends SealError {
  readonly backendUrl: string;

  constructor(backendUrl: string, options?: { cause?: unknown }) {
    super('backend-unreachable', `no Bee API answered at ${backendUrl}`, options);
    this.backendUrl = backendUrl;
  }
}

/**
 * Extracts an HTTP status from whatever bee-js threw.
 *
 * `BeeResponseError` carries `status` directly, but the same call can surface a
 * plain fetch failure or a wrapped cause, so all three shapes are probed.
 */
export function httpStatusOf(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null) return undefined;

  const direct = (error as { status?: unknown }).status;
  if (typeof direct === 'number') return direct;

  const response = (error as { response?: { status?: unknown } }).response;
  if (response && typeof response.status === 'number') return response.status;

  const cause = (error as { cause?: unknown }).cause;
  if (cause && cause !== error) return httpStatusOf(cause);

  return undefined;
}

/**
 * True when Swarm answered 404.
 *
 * Swarm returns 404 both for content that never existed and for ACT content the
 * caller holds no key for — that indistinguishability is the privacy property we
 * are relying on, so this predicate is deliberately the only signal we get.
 */
export function isNotFound(error: unknown): boolean {
  return httpStatusOf(error) === 404;
}
