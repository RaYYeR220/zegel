/**
 * Typed failures. Every one of these is a distinguishable operator mistake, not a generic RPC blowup.
 *
 * Written without TypeScript parameter properties so the sources run unbuilt under
 * Node's type stripping — `node src/cli/index.ts` has to work with no build step.
 */

export class ZegelSolanaError extends Error {
  override readonly name: string = 'ZegelSolanaError';
}

/** An attestation already exists at the derived PDA for this subject. */
export class AttestationExistsError extends ZegelSolanaError {
  override readonly name = 'AttestationExistsError';
  readonly attestation: string;
  readonly existingReferenceId: string;

  constructor(attestation: string, existingReferenceId: string) {
    super(
      `an attestation already exists at ${attestation} anchoring reference ${existingReferenceId}. ` +
        'The attestation PDA is keyed on the subject, so a subject holds at most one live reference per schema version — revoke the existing one first.',
    );
    this.attestation = attestation;
    this.existingReferenceId = existingReferenceId;
  }
}

export class AttestationNotFoundError extends ZegelSolanaError {
  override readonly name = 'AttestationNotFoundError';
  readonly attestation: string;

  constructor(attestation: string) {
    super(`no attestation account at ${attestation}`);
    this.attestation = attestation;
  }
}

/** `close` refuses a live attestation: closing one early is revocation, and should say so. */
export class AttestationNotExpiredError extends ZegelSolanaError {
  override readonly name = 'AttestationNotExpiredError';
  readonly attestation: string;
  readonly expiresAt: bigint;

  constructor(attestation: string, expiresAt: bigint) {
    const when =
      expiresAt === 0n
        ? 'never expires'
        : `does not expire until ${new Date(Number(expiresAt) * 1000).toISOString()}`;
    super(
      `attestation ${attestation} ${when}. ` +
        'close() only reclaims rent from references that have already lapsed; to withdraw a live reference use revoke().',
    );
    this.attestation = attestation;
    this.expiresAt = expiresAt;
  }
}

/** The requested reference id is not the one anchored at this subject's PDA. */
export class ReferenceMismatchError extends ZegelSolanaError {
  override readonly name = 'ReferenceMismatchError';
  readonly expected: string;
  readonly found: string;

  constructor(expected: string, found: string) {
    super(`attestation anchors reference ${found}, not ${expected}`);
    this.expected = expected;
    this.found = found;
  }
}

export class IssuerNotInitializedError extends ZegelSolanaError {
  override readonly name = 'IssuerNotInitializedError';

  constructor(what: string, address: string) {
    super(`${what} account ${address} does not exist — run createIssuer() (or \`zegel-sas status\`) first`);
  }
}

export class TransactionFailedError extends ZegelSolanaError {
  override readonly name = 'TransactionFailedError';
  readonly signature: string;
  readonly onchainError: unknown;

  constructor(signature: string, onchainError: unknown) {
    super(`transaction ${signature} failed on-chain: ${JSON.stringify(onchainError)}`);
    this.signature = signature;
    this.onchainError = onchainError;
  }
}

export class ConfirmationTimeoutError extends ZegelSolanaError {
  override readonly name = 'ConfirmationTimeoutError';
  readonly signature: string;

  constructor(signature: string, timeoutMs: number) {
    super(`transaction ${signature} was not confirmed within ${timeoutMs}ms`);
    this.signature = signature;
  }
}

/** The RPC refused the transaction. Preflight logs are the only part worth reading. */
export class SendFailedError extends ZegelSolanaError {
  override readonly name = 'SendFailedError';
  readonly signature: string;
  readonly logs: string[];

  constructor(signature: string, cause: unknown) {
    const logs = extractLogs(cause);
    const detail = cause instanceof Error ? cause.message : String(cause);
    super(
      `transaction ${signature} was rejected: ${detail}` +
        (logs.length > 0 ? `\nprogram logs:\n  ${logs.join('\n  ')}` : ''),
    );
    this.signature = signature;
    this.logs = logs;
    this.cause = cause;
  }
}

function extractLogs(cause: unknown): string[] {
  if (typeof cause !== 'object' || cause === null) return [];
  const context = (cause as { context?: unknown }).context;
  if (typeof context !== 'object' || context === null) return [];
  const logs = (context as { logs?: unknown }).logs;
  return Array.isArray(logs) ? logs.map(String) : [];
}
