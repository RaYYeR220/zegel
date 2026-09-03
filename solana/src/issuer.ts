/**
 * Issuer setup: the Zegel credential, its versioned schema, and the schema's
 * Token-2022 group mint.
 *
 * Idempotent by construction. Every account here is a PDA of fixed seeds, so
 * "already set up" is a question about account existence, not about state we
 * have to remember somewhere. Re-running this on a live issuer sends nothing.
 */

import { getMintSize } from '@solana-program/token-2022';
import type { Instruction, Signature } from '@solana/kit';
import {
  fetchMaybeSchema,
  getCreateCredentialInstruction,
  getCreateSchemaInstruction,
  getTokenizeSchemaInstruction,
} from 'sas-lib';
import {
  CREDENTIAL_NAME,
  SCHEMA_DESCRIPTION,
  SCHEMA_NAME,
} from './constants.ts';
import type { ZegelIssuerContext } from './context.ts';
import { deriveIssuerAddresses, TOKEN_2022_PROGRAM_ADDRESS } from './pdas.ts';
import {
  accountExists,
  createRpc,
  type KeypairInput,
  type SendOptions,
  sendInstructions,
  toSigner,
} from './rpc.ts';
import { assertSchemaMatchesExpected, ZEGEL_SCHEMA_FIELDS, ZEGEL_SCHEMA_LAYOUT } from './schema.ts';
import type { IssuerSetupResult } from './types.ts';

export interface CreateIssuerOptions {
  rpcUrl: string;
  keypair: KeypairInput;
  /** Skip the on-chain setup and just build the handle. Useful when the credential is known live. */
  skipSetup?: boolean;
  sendOptions?: SendOptions;
}

export interface ZegelIssuer extends ZegelIssuerContext {
  setup: IssuerSetupResult;
}

export async function createIssuer(options: CreateIssuerOptions): Promise<ZegelIssuer> {
  const { rpcUrl, keypair, skipSetup = false, sendOptions = {} } = options;
  const rpc = createRpc(rpcUrl);
  const authority = await toSigner(keypair);
  const addresses = await deriveIssuerAddresses(authority.address);
  const context: ZegelIssuerContext = { rpcUrl, rpc, authority, addresses, sendOptions };

  const setup = skipSetup
    ? { created: { credential: false, schema: false, schemaMint: false }, signature: null }
    : await setupIssuer(context);

  return { ...context, setup };
}

/** The idempotent half of `createIssuer`, exposed for callers that already hold a context. */
export async function setupIssuer(context: ZegelIssuerContext): Promise<IssuerSetupResult> {
  const { rpc, authority, addresses } = context;
  const { credential, schema, schemaMint, sasPda } = addresses;

  const [credentialLive, schemaAccount, schemaMintLive] = await Promise.all([
    accountExists(rpc, credential),
    fetchMaybeSchema(rpc, schema),
    accountExists(rpc, schemaMint),
  ]);

  // A live schema whose layout drifted from ours would silently change what every
  // attestation means, so refuse rather than issue against it.
  if (schemaAccount.exists) assertSchemaMatchesExpected(schemaAccount.data);

  const instructions: Instruction[] = [];

  if (!credentialLive) {
    instructions.push(
      getCreateCredentialInstruction({
        payer: authority,
        credential,
        authority,
        name: CREDENTIAL_NAME,
        signers: [authority.address],
      }),
    );
  }

  if (!schemaAccount.exists) {
    instructions.push(
      getCreateSchemaInstruction({
        payer: authority,
        authority,
        credential,
        schema,
        name: SCHEMA_NAME,
        description: SCHEMA_DESCRIPTION,
        layout: Uint8Array.from(ZEGEL_SCHEMA_LAYOUT),
        fieldNames: [...ZEGEL_SCHEMA_FIELDS],
      }),
    );
  }

  if (!schemaMintLive) {
    instructions.push(
      getTokenizeSchemaInstruction({
        payer: authority,
        authority,
        credential,
        schema,
        mint: schemaMint,
        sasPda,
        tokenProgram: TOKEN_2022_PROGRAM_ADDRESS,
        maxSize: getMintSize([
          { __kind: 'GroupPointer', authority: sasPda, groupAddress: schemaMint },
        ]),
      }),
    );
  }

  const created = {
    credential: !credentialLive,
    schema: !schemaAccount.exists,
    schemaMint: !schemaMintLive,
  };

  let signature: Signature | null = null;
  if (instructions.length > 0) {
    signature = await sendInstructions(rpc, authority, instructions, {
      computeUnitLimit: 400_000,
      ...context.sendOptions,
    });
  }

  return { created, signature };
}
