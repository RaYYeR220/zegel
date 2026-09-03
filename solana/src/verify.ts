/**
 * Verification. No keypair, no issuer cooperation, no index.
 *
 * A verifier needs three public facts — the issuer's authority pubkey, the
 * subject's pubkey, and the reference id — and derives everything else. The
 * commitment they were shown off-chain is then checked against the one anchored
 * on-chain, which is the whole point: a tampered claim set produces a different
 * sha256 and fails here.
 */

import { type Address, address, getBase58Encoder } from '@solana/kit';
import {
  fetchMaybeAttestation,
  fetchMaybeSchema,
  identifySolanaAttestationServiceInstruction,
  SolanaAttestationServiceInstruction,
} from 'sas-lib';
import { SAS_PROGRAM_ADDRESS } from './constants.ts';
import { hexEqual, normalizeHex32 } from './hex.ts';
import { deriveIssuerAddresses, deriveReferenceAddresses } from './pdas.ts';
import { createRpc, type SolanaRpc } from './rpc.ts';
import {
  assertSchemaMatchesExpected,
  decodeReferenceData,
  SchemaDriftError,
  schemaMatchesExpected,
} from './schema.ts';
import type { ReferenceStatus, RevocationEvidence, VerifyResult } from './types.ts';

export interface VerifyOptions {
  /** Any HTTP RPC for the cluster the reference was anchored on. */
  rpcUrl?: string;
  rpc?: SolanaRpc;
  /** The issuer's credential authority pubkey. Public; published in the envelope. */
  issuerAuthority: Address | string;
  subject: Address | string;
  referenceId: string;
  /** sha256 over the canonical ClaimSet the verifier was shown. */
  commitment?: string;
  /** Overrides the clock, for tests. */
  now?: Date;
  /**
   * Look up the PDA's signature history when the account is absent, to tell a
   * revoked reference from one that never existed. One extra RPC round trip.
   */
  checkRevocationHistory?: boolean;
}

export async function verify(options: VerifyOptions): Promise<VerifyResult> {
  const {
    referenceId: rawReferenceId,
    commitment: rawCommitment,
    now = new Date(),
    checkRevocationHistory = true,
  } = options;

  const rpc = options.rpc ?? createRpc(requireRpcUrl(options.rpcUrl));
  const subject = address(String(options.subject));
  const referenceId = normalizeHex32('referenceId', rawReferenceId);
  const commitment = rawCommitment === undefined ? undefined : normalizeHex32('commitment', rawCommitment);

  const issuerAddresses = await deriveIssuerAddresses(address(String(options.issuerAuthority)));
  const { credential, schema } = issuerAddresses;
  const { attestation, attestationMint } = await deriveReferenceAddresses({ credential, schema }, subject);

  const [schemaAccount, attestationAccount] = await Promise.all([
    fetchMaybeSchema(rpc, schema),
    fetchMaybeAttestation(rpc, attestation),
  ]);

  const base = {
    subject,
    referenceId,
    attestation,
    credential,
    schema,
    attestationMint,
    schemaPaused: schemaAccount.exists ? schemaAccount.data.isPaused : false,
    schemaMatchesExpected: schemaAccount.exists ? schemaMatchesExpected(schemaAccount.data) : false,
    checkedAt: now.toISOString(),
  } satisfies Omit<VerifyResult, 'status' | 'detail'>;

  if (!schemaAccount.exists) {
    return {
      ...base,
      status: 'not-found',
      detail: `no Zegel schema at ${schema} — this issuer authority has never set up a credential on this cluster`,
    };
  }

  if (!attestationAccount.exists) {
    const history = checkRevocationHistory
      ? await findRevocation(rpc, attestation)
      : { successfulSignatures: 0 };

    if (history.evidence) {
      const { evidence } = history;
      return {
        ...base,
        status: 'revoked',
        detail:
          `attestation ${attestation} was closed by the issuer in transaction ${evidence.signature}` +
          (evidence.blockTime ? ` at ${new Date(evidence.blockTime * 1000).toISOString()}` : ''),
        revocation: evidence,
      };
    }

    return {
      ...base,
      status: 'not-found',
      detail: `no attestation at ${attestation}` + notFoundReason(checkRevocationHistory, history),
    };
  }

  // The codec is built from whatever field order the live schema declares, so a
  // same-width reorder — referenceId and commitment are both Vec<u8> — would decode
  // cleanly into swapped values rather than failing. Check the layout before trusting
  // anything read out of it; drift is a loud failure, not a status.
  assertSchemaMatchesExpected(schemaAccount.data);

  let onchain;
  try {
    onchain = decodeReferenceData(
      Uint8Array.from(attestationAccount.data.data),
      schemaAccount.data,
    );
  } catch (error) {
    throw new SchemaDriftError(
      `attestation ${attestation} could not be decoded against live schema ${schema}: ` +
        `${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const tokenAccount = attestationAccount.data.tokenAccount;
  const withData = { ...base, onchain, tokenAccount };

  if (!hexEqual(onchain.referenceId, referenceId)) {
    return {
      ...withData,
      status: 'reference-mismatch',
      detail: `this subject's live reference is ${onchain.referenceId}, not ${referenceId}`,
    };
  }

  if (commitment !== undefined && !hexEqual(onchain.commitment, commitment)) {
    return {
      ...withData,
      status: 'commitment-mismatch',
      detail: `the claims presented hash to ${commitment}; the anchored commitment is ${onchain.commitment}`,
    };
  }

  if (base.schemaPaused) {
    return {
      ...withData,
      status: 'schema-paused',
      detail: `the issuer has paused schema ${schema}; no attestation under it should be relied on`,
    };
  }

  const nowSeconds = BigInt(Math.floor(now.getTime() / 1000));
  const expiry = attestationAccount.data.expiry;
  if (expiry !== 0n && expiry <= nowSeconds) {
    return {
      ...withData,
      status: 'expired',
      detail: `the reference expired at ${new Date(Number(expiry) * 1000).toISOString()}`,
    };
  }

  return {
    ...withData,
    status: 'valid',
    detail:
      commitment === undefined
        ? `attestation is live until ${isoOrNever(expiry)}. No commitment was supplied, so the claim contents were not checked.`
        : `commitment matches the anchored reference; live until ${isoOrNever(expiry)}`,
  };
}

function isoOrNever(expiry: bigint): string {
  return expiry === 0n ? 'no expiry' : new Date(Number(expiry) * 1000).toISOString();
}

function requireRpcUrl(rpcUrl: string | undefined): string {
  if (!rpcUrl) throw new TypeError('verify() needs either an `rpc` client or an `rpcUrl`');
  return rpcUrl;
}

/** How many recent transactions at the PDA to inspect before giving up. */
const MAX_HISTORY_TRANSACTIONS = 5;

interface RevocationSearch {
  /** Present only when a close instruction was positively identified. */
  evidence?: RevocationEvidence;
  /** Successful transactions seen at the address, whatever they contained. */
  successfulSignatures: number;
}

/**
 * An absent account whose address carries a SAS close instruction was revoked. The
 * closing transaction is public and permanent; the account is not.
 *
 * The close has to be positively identified. Attestation addresses are derivable by
 * anyone, and anyone can name a derivable address in a transaction of their own — so
 * "the account is gone and something happened here" is not evidence the issuer revoked
 * anything, and reporting it as such would attribute an action to the issuer that
 * never happened, for the price of one transaction fee.
 */
async function findRevocation(rpc: SolanaRpc, attestation: Address): Promise<RevocationSearch> {
  let signatures: Awaited<ReturnType<ReturnType<SolanaRpc['getSignaturesForAddress']>['send']>>;
  try {
    signatures = await rpc.getSignaturesForAddress(attestation, { limit: 20 }).send();
  } catch {
    return { successfulSignatures: 0 };
  }

  const successful = signatures.filter((s) => s.err === null);
  // Newest first, and a close is normally newest — but later traffic at the address
  // must not bury it, so walk back a few.
  for (const candidate of successful.slice(0, MAX_HISTORY_TRANSACTIONS)) {
    const instruction = await identifyClosingInstruction(rpc, String(candidate.signature));
    if (instruction === undefined) continue;
    return {
      successfulSignatures: successful.length,
      evidence: {
        signature: String(candidate.signature),
        slot: Number(candidate.slot),
        blockTime:
          candidate.blockTime === null || candidate.blockTime === undefined
            ? null
            : Number(candidate.blockTime),
        instruction,
      },
    };
  }

  return { successfulSignatures: successful.length };
}

function notFoundReason(checked: boolean, history: RevocationSearch): string {
  if (!checked) return ' (revocation history not checked)';
  if (history.successfulSignatures === 0) {
    return ' and no transaction history there. Public RPCs prune history, so this is not proof one never existed.';
  }
  return (
    `. Its address carries ${history.successfulSignatures} successful transaction(s), but none of the ` +
    `${MAX_HISTORY_TRANSACTIONS} most recent contains an attestation-close instruction — anyone can name a ` +
    'derivable address in a transaction, so that is not evidence the issuer revoked anything.'
  );
}

async function identifyClosingInstruction(
  rpc: SolanaRpc,
  signature: string,
): Promise<RevocationEvidence['instruction'] | undefined> {
  try {
    const tx = await rpc
      .getTransaction(signature as Parameters<SolanaRpc['getTransaction']>[0], {
        encoding: 'jsonParsed',
        maxSupportedTransactionVersion: 0,
      })
      .send();
    if (!tx) return undefined;

    const base58 = getBase58Encoder();
    type ParsedInstruction = { programId?: string; data?: string };
    const inner = ((tx.meta?.innerInstructions ?? []) as ReadonlyArray<{
      instructions?: ReadonlyArray<ParsedInstruction>;
    }>).flatMap((group) => group.instructions ?? []);
    // A close reached through a multisig or any other CPI is an inner instruction,
    // so scanning only the top level would report `unknown` for a real revocation.
    const candidates: ReadonlyArray<ParsedInstruction> = [
      ...((tx.transaction.message.instructions ?? []) as ReadonlyArray<ParsedInstruction>),
      ...inner,
    ];

    for (const instruction of candidates) {
      if (instruction.programId !== SAS_PROGRAM_ADDRESS || !instruction.data) continue;
      let kind: SolanaAttestationServiceInstruction;
      try {
        kind = identifySolanaAttestationServiceInstruction(
          Uint8Array.from(base58.encode(instruction.data)),
        );
      } catch {
        // An instruction this client version cannot name is not a reason to stop
        // looking at the rest of the transaction.
        continue;
      }
      if (kind === SolanaAttestationServiceInstruction.CloseTokenizedAttestation) {
        return 'CloseTokenizedAttestation';
      }
      if (kind === SolanaAttestationServiceInstruction.CloseAttestation) return 'CloseAttestation';
    }
    return undefined;
  } catch {
    return undefined;
  }
}

export type { ReferenceStatus };
