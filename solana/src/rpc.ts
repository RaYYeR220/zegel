/**
 * Transaction plumbing.
 *
 * Confirmation is done by polling `getSignatureStatuses` rather than the websocket
 * factory kit ships with: the read path here has to work against whatever HTTP RPC
 * a verifier already has, and requiring a second websocket endpoint is a needless
 * way for verification to fail on someone else's infrastructure.
 */

import {
  type Address,
  type Commitment,
  type Instruction,
  type KeyPairSigner,
  type Rpc,
  type Signature,
  type SolanaRpcApi,
  appendTransactionMessageInstructions,
  createKeyPairSignerFromBytes,
  createSolanaRpc,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  getSignatureFromTransaction,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
} from '@solana/kit';
import {
  getSetComputeUnitLimitInstruction,
  getSetComputeUnitPriceInstruction,
} from '@solana-program/compute-budget';
import { ConfirmationTimeoutError, SendFailedError, TransactionFailedError } from './errors.ts';

export type SolanaRpc = Rpc<SolanaRpcApi>;

/** Anything that can stand in for the issuer's signing key. */
export type KeypairInput = KeyPairSigner | Uint8Array | readonly number[];

export function createRpc(rpcUrl: string): SolanaRpc {
  return createSolanaRpc(rpcUrl);
}

export async function toSigner(keypair: KeypairInput): Promise<KeyPairSigner> {
  if (typeof keypair === 'object' && keypair !== null && 'address' in keypair) {
    return keypair as KeyPairSigner;
  }
  const bytes = keypair instanceof Uint8Array ? keypair : Uint8Array.from(keypair as readonly number[]);
  if (bytes.length !== 64) {
    throw new TypeError(`expected a 64-byte ed25519 keypair, got ${bytes.length} bytes`);
  }
  return createKeyPairSignerFromBytes(bytes);
}

export interface SendOptions {
  /** Explicit CU limit. SAS attestation instructions create Token-2022 mints and blow past the 200k default. */
  computeUnitLimit?: number;
  /** Priority fee. Zero by default; devnet does not need one and mainnet cost should be an explicit choice. */
  computeUnitPriceMicroLamports?: number;
  commitment?: Commitment;
  /** Skip preflight simulation. Leave off — preflight is where the useful program logs come from. */
  skipPreflight?: boolean;
  confirmTimeoutMs?: number;
}

export async function sendInstructions(
  rpc: SolanaRpc,
  feePayer: KeyPairSigner,
  instructions: readonly Instruction[],
  options: SendOptions = {},
): Promise<Signature> {
  const {
    computeUnitLimit = 400_000,
    computeUnitPriceMicroLamports = 0,
    commitment = 'confirmed',
    skipPreflight = false,
    confirmTimeoutMs = 90_000,
  } = options;

  const budget: Instruction[] = [getSetComputeUnitLimitInstruction({ units: computeUnitLimit })];
  if (computeUnitPriceMicroLamports > 0) {
    budget.push(
      getSetComputeUnitPriceInstruction({ microLamports: BigInt(computeUnitPriceMicroLamports) }),
    );
  }

  const { value: latestBlockhash } = await rpc.getLatestBlockhash({ commitment }).send();

  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayerSigner(feePayer, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(latestBlockhash, m),
    (m) => appendTransactionMessageInstructions([...budget, ...instructions], m),
  );

  const signed = await signTransactionMessageWithSigners(message);
  const signature = getSignatureFromTransaction(signed);

  try {
    await rpc
      .sendTransaction(getBase64EncodedWireTransaction(signed), {
        encoding: 'base64',
        preflightCommitment: commitment,
        skipPreflight,
        maxRetries: 5n,
      })
      .send();
  } catch (error) {
    // Preflight failures carry the program logs, which are the only useful part.
    // Kit buries them in `context`; surface them rather than reporting a bare code.
    throw new SendFailedError(signature, error);
  }

  await confirmSignature(rpc, signature, { commitment, timeoutMs: confirmTimeoutMs });
  return signature;
}

export async function confirmSignature(
  rpc: SolanaRpc,
  signature: Signature,
  { commitment = 'confirmed', timeoutMs = 90_000 }: { commitment?: Commitment; timeoutMs?: number } = {},
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  const accepted = commitment === 'finalized' ? ['finalized'] : ['confirmed', 'finalized'];
  while (Date.now() < deadline) {
    const { value } = await rpc
      .getSignatureStatuses([signature], { searchTransactionHistory: true })
      .send();
    const status = value[0];
    if (status) {
      if (status.err) throw new TransactionFailedError(signature, status.err);
      if (status.confirmationStatus && accepted.includes(status.confirmationStatus)) return;
    }
    await new Promise((resolve) => setTimeout(resolve, 700));
  }
  throw new ConfirmationTimeoutError(signature, timeoutMs);
}

/** True when an account exists on chain. Used for every idempotency check in this package. */
export async function accountExists(rpc: SolanaRpc, address_: Address): Promise<boolean> {
  const { value } = await rpc.getAccountInfo(address_, { encoding: 'base64' }).send();
  return value !== null;
}

export async function getBalanceSol(rpc: SolanaRpc, address_: Address): Promise<number> {
  const { value } = await rpc.getBalance(address_).send();
  return Number(value) / 1_000_000_000;
}
