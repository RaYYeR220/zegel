/** Shared test fixtures: a fake RPC that serves encoded SAS accounts. */

import { address, type Address } from '@solana/kit';
import { getAttestationEncoder, getSchemaEncoder, type Attestation, type Schema } from 'sas-lib';
import { ACCOUNT_DISCRIMINATOR, SAS_PROGRAM_ADDRESS } from '../src/constants.ts';
import { localSchemaAccount } from '../src/schema.ts';
import type { SolanaRpc } from '../src/rpc.ts';

/** The project's Solana authority. Public key only — no key material anywhere in this repo. */
export const ISSUER_AUTHORITY = address('BW2UCEkixRcSAAsfUEKe2YZMXLNUMwxZqBpCGBEQ7tD9');
export const SUBJECT = address('SysvarC1ock11111111111111111111111111111111');
export const OTHER_SUBJECT = address('SysvarRent111111111111111111111111111111111');

export const REFERENCE_ID = `0x${'11'.repeat(32)}`;
export const COMMITMENT = `0x${'ab'.repeat(32)}`;
export const DERIVATION_ID = `0x${'7f'.repeat(32)}`;
/** Same length, one byte different — the tampered-claims negative control. */
export const TAMPERED_COMMITMENT = `0x${'ab'.repeat(31)}ac`;

export function schemaAccountBytes(overrides: Partial<Schema> = {}): Uint8Array {
  const schema: Schema = {
    ...localSchemaAccount(),
    discriminator: ACCOUNT_DISCRIMINATOR.schema,
    ...overrides,
  };
  return Uint8Array.from(getSchemaEncoder().encode(schema));
}

export function attestationAccountBytes(input: {
  nonce: Address;
  credential: Address;
  schema: Address;
  data: Uint8Array;
  signer: Address;
  expiry: bigint;
  tokenAccount: Address;
}): Uint8Array {
  const attestation: Attestation = {
    discriminator: ACCOUNT_DISCRIMINATOR.attestation,
    ...input,
  };
  return Uint8Array.from(getAttestationEncoder().encode(attestation));
}

export interface FakeSignature {
  signature: string;
  slot: bigint;
  blockTime: bigint | null;
  err: unknown;
}

export interface FakeRpcState {
  accounts: Record<string, Uint8Array>;
  signatures?: Record<string, FakeSignature[]>;
  /** Instruction data (base58) attributed to the SAS program in the closing transaction. */
  transactionInstructions?: { programId: string; data: string }[];
  /** Same, but nested under an inner-instruction group, as a CPI would appear. */
  innerTransactionInstructions?: { programId: string; data: string }[];
  /** Per-signature override, for histories where the close is not the newest entry. */
  transactionsBySignature?: Record<string, { programId: string; data: string }[]>;
  calls?: string[];
}

/**
 * A hand-rolled RPC double. The status matrix has to be exercised against every
 * account shape including ones we cannot conjure on a live cluster (a paused
 * schema, an expired attestation), so the read path is tested here and the
 * happy path is tested for real in the devnet integration test.
 */
export function fakeRpc(state: FakeRpcState): SolanaRpc {
  const calls = state.calls ?? [];
  const rpc = {
    getAccountInfo(addr: Address) {
      calls.push(`getAccountInfo:${addr}`);
      const bytes = state.accounts[addr as string];
      return {
        send: async () => ({
          context: { slot: 1n },
          value: bytes
            ? {
                data: [Buffer.from(bytes).toString('base64'), 'base64'],
                executable: false,
                lamports: 1_000_000n,
                owner: SAS_PROGRAM_ADDRESS,
                rentEpoch: 0n,
                space: BigInt(bytes.length),
              }
            : null,
        }),
      };
    },
    getSignaturesForAddress(addr: Address) {
      calls.push(`getSignaturesForAddress:${addr}`);
      return { send: async () => state.signatures?.[addr as string] ?? [] };
    },
    getTransaction(signature: string) {
      calls.push(`getTransaction:${signature}`);
      const perSignature = state.transactionsBySignature?.[signature];
      const top = perSignature ?? state.transactionInstructions;
      const inner = perSignature ? undefined : state.innerTransactionInstructions;
      return {
        send: async () =>
          top || inner
            ? {
                transaction: { message: { instructions: top ?? [] } },
                meta: inner
                  ? { innerInstructions: [{ index: 0, instructions: inner }] }
                  : undefined,
              }
            : null,
      };
    },
    getBalance(addr: Address) {
      calls.push(`getBalance:${addr}`);
      return { send: async () => ({ context: { slot: 1n }, value: 0n }) };
    },
  };
  return rpc as unknown as SolanaRpc;
}
