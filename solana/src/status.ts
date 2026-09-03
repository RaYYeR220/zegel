/** Read-only view of an issuer's on-chain state. Needs no keypair. */

import { address, type Address } from '@solana/kit';
import { fetchMaybeCredential, fetchMaybeSchema } from 'sas-lib';
import { CREDENTIAL_NAME, SCHEMA_NAME, SCHEMA_VERSION } from './constants.ts';
import { deriveIssuerAddresses, type IssuerAddresses } from './pdas.ts';
import { accountExists, createRpc, getBalanceSol, type SolanaRpc } from './rpc.ts';
import { decodeFieldNames, schemaMatchesExpected, ZEGEL_SCHEMA_FIELDS } from './schema.ts';

export interface IssuerStatus {
  addresses: IssuerAddresses;
  credentialLive: boolean;
  /** Addresses the credential accepts as attestation signers. */
  authorizedSigners: Address[];
  schemaLive: boolean;
  schemaPaused: boolean;
  schemaVersion: number | null;
  schemaFields: string[];
  schemaMatchesExpected: boolean;
  schemaMintLive: boolean;
  authorityBalanceSol: number;
  names: { credential: string; schema: string; version: number };
}

export async function issuerStatus(options: {
  rpcUrl?: string;
  rpc?: SolanaRpc;
  issuerAuthority: Address | string;
}): Promise<IssuerStatus> {
  const rpc = options.rpc ?? createRpc(requireUrl(options.rpcUrl));
  const authority = address(String(options.issuerAuthority));
  const addresses = await deriveIssuerAddresses(authority);

  const [credential, schema, schemaMintLive, authorityBalanceSol] = await Promise.all([
    fetchMaybeCredential(rpc, addresses.credential),
    fetchMaybeSchema(rpc, addresses.schema),
    accountExists(rpc, addresses.schemaMint),
    getBalanceSol(rpc, authority),
  ]);

  return {
    addresses,
    credentialLive: credential.exists,
    authorizedSigners: credential.exists ? [...credential.data.authorizedSigners] : [],
    schemaLive: schema.exists,
    schemaPaused: schema.exists ? schema.data.isPaused : false,
    schemaVersion: schema.exists ? schema.data.version : null,
    schemaFields: schema.exists
      ? decodeFieldNames(Uint8Array.from(schema.data.fieldNames))
      : [...ZEGEL_SCHEMA_FIELDS],
    schemaMatchesExpected: schema.exists ? schemaMatchesExpected(schema.data) : false,
    schemaMintLive,
    authorityBalanceSol,
    names: { credential: CREDENTIAL_NAME, schema: SCHEMA_NAME, version: SCHEMA_VERSION },
  };
}

function requireUrl(rpcUrl: string | undefined): string {
  if (!rpcUrl) throw new TypeError('issuerStatus() needs either an `rpc` client or an `rpcUrl`');
  return rpcUrl;
}
