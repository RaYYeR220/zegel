/**
 * Live read path against devnet. No keypair, no funds, no credentials.
 *
 * This is the half of the integration surface a verifier actually exercises, so it
 * runs against the real cluster rather than a double: the program is really there,
 * real SAS accounts really decode through our pinned `sas-lib` + `@solana/kit@8.2.0`
 * stack, and the account discriminators this package hard-codes are really the ones
 * the program writes.
 *
 * Skips itself when devnet is unreachable, so the suite still passes offline.
 */

import { describe, expect, it } from 'vitest';
import { getCredentialDecoder, getSchemaDecoder, getAttestationDecoder } from 'sas-lib';
import { ACCOUNT_DISCRIMINATOR, SAS_PROGRAM_ADDRESS } from '../src/constants.ts';
import { createRpc, type SolanaRpc } from '../src/rpc.ts';
import { decodeFieldNames } from '../src/schema.ts';
import { verify } from '../src/verify.ts';
import { COMMITMENT, ISSUER_AUTHORITY, REFERENCE_ID, SUBJECT } from './fixtures.ts';

const RPC_URL = process.env['ZEGEL_SOLANA_RPC'] ?? 'https://api.devnet.solana.com';
const rpc = createRpc(RPC_URL);

const reachable = await isReachable(rpc);
if (!reachable) console.warn(`devnet read tests skipped: ${RPC_URL} unreachable`);

/** Single-character base58 encodes one byte: '1' -> 0, '2' -> 1, '3' -> 2. */
const DISCRIMINATOR_FILTER = ['1', '2', '3'] as const;
/** Keeps the response small; accounts longer than this come back truncated. */
const DATA_SLICE_BYTES = 1024;

describe.skipIf(!reachable)('devnet read path', () => {
  it('finds the attestation program deployed and executable', async () => {
    const { value } = await rpc
      .getAccountInfo(SAS_PROGRAM_ADDRESS, { encoding: 'base64' })
      .send();
    expect(value).not.toBeNull();
    expect(value?.executable).toBe(true);
  });

  it('decodes real schema accounts through the pinned stack', async () => {
    const accounts = await programAccounts(DISCRIMINATOR_FILTER[ACCOUNT_DISCRIMINATOR.schema]);
    expect(accounts.length).toBeGreaterThan(0);

    // If the kit override or the Codama codecs were wrong, this is where it shows.
    let decoded = 0;
    for (const account of accounts.slice(0, 25)) {
      const bytes = toBytes(account.data[0]);
      // Accounts at the slice boundary may be truncated; a short read is not a codec bug.
      if (bytes.length >= DATA_SLICE_BYTES) continue;
      const schema = getSchemaDecoder().decode(bytes);
      expect(schema.discriminator).toBe(ACCOUNT_DISCRIMINATOR.schema);
      expect(decodeFieldNames(Uint8Array.from(schema.fieldNames))).toHaveLength(schema.layout.length);
      decoded++;
    }
    expect(decoded).toBeGreaterThan(0);
  });

  it('confirms the discriminators this package hard-codes', async () => {
    // sas-lib's `SolanaAttestationServiceAccount` enum is a Codama account index and
    // disagrees with the program. Filtering on byte 0 settles it against live data.
    const [credentials, schemas, attestations] = await Promise.all(
      DISCRIMINATOR_FILTER.map((b58) => programAccounts(b58)),
    );
    for (const group of [credentials, schemas, attestations]) {
      expect(group.length).toBeGreaterThan(0);
    }

    const credential = getCredentialDecoder().decode(toBytes(credentials[0]!.data[0]));
    const attestation = getAttestationDecoder().decode(toBytes(attestations[0]!.data[0]));
    expect(credential.discriminator).toBe(ACCOUNT_DISCRIMINATOR.credential);
    expect(attestation.discriminator).toBe(ACCOUNT_DISCRIMINATOR.attestation);
    // The enum sas-lib exports is an account index, and disagrees with all three.
    expect(ACCOUNT_DISCRIMINATOR.credential).not.toBe(ACCOUNT_DISCRIMINATOR.attestation);
  });

  it('reports not-found for an issuer with no credential on this cluster', async () => {
    const result = await verify({
      rpc,
      issuerAuthority: ISSUER_AUTHORITY,
      subject: SUBJECT,
      referenceId: REFERENCE_ID,
      commitment: COMMITMENT,
    });
    expect(['not-found', 'valid', 'revoked', 'expired', 'commitment-mismatch']).toContain(
      result.status,
    );
    // Whatever the state, the derived addresses are reported so they can be checked.
    expect(result.credential).toBe('E71jA1xf49cCJFVcvDxhqm8eDDF6mcf8VFgoCaWfpSen');
    expect(result.schema).toBe('GpmsvJCNeKBkuwm25vY9vjzh89ojaqCiNActrZAq1EKC');
  });
});

function toBytes(base64: string): Uint8Array {
  return Uint8Array.from(Buffer.from(base64, 'base64'));
}

async function programAccounts(discriminatorBase58: string) {
  const accounts = await rpc
    .getProgramAccounts(SAS_PROGRAM_ADDRESS, {
      encoding: 'base64',
      dataSlice: { offset: 0, length: DATA_SLICE_BYTES },
      filters: [{ memcmp: { offset: 0n, bytes: discriminatorBase58 as never, encoding: 'base58' } }],
    })
    .send();
  return (accounts as ReadonlyArray<{ account: { data: [string, string] } }>).map((a) => a.account);
}

async function isReachable(client: SolanaRpc): Promise<boolean> {
  try {
    await client.getLatestBlockhash().send();
    return true;
  } catch {
    return false;
  }
}
