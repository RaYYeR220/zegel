/**
 * The live mainnet reference, checked on every run. No keypair, no funds.
 *
 * This is the deployment claim made falsifiable: if the attestation is ever revoked,
 * moved, re-issued under a different commitment, or the issuer's schema drifts, this
 * suite goes red rather than the README quietly becoming untrue.
 *
 * Skips itself when mainnet is unreachable, so the suite still passes offline.
 */

import { describe, expect, it } from 'vitest';
import { address } from '@solana/kit';
import { deriveIssuerAddresses, deriveReferenceAddresses } from '../src/pdas.ts';
import { createRpc, type SolanaRpc } from '../src/rpc.ts';
import { verify } from '../src/verify.ts';

const RPC_URL = process.env['ZEGEL_MAINNET_RPC'] ?? 'https://api.mainnet-beta.solana.com';
const rpc = createRpc(RPC_URL);

/** Deployed 2026-09-04. The same reference anchored on Ethereum and Base. */
const ISSUER = address('BW2UCEkixRcSAAsfUEKe2YZMXLNUMwxZqBpCGBEQ7tD9');
const SUBJECT = ISSUER;
const REFERENCE_ID = '0xa5a4d829143280bd2ad24c33c9f94da4e37cf6d5d29ba1acef4c9b2a96f51a9f';
const COMMITMENT = '0xce99fc040a03fb82d617b61fce60933590049b003b7b5b989f7c3681f1b3fca5';
const DERIVATION_ID = '0xcd0528ad537c9547d4c9c687165e65a67df2a7582635f4b8f236acb2405415fa';
/** One hex digit changed in the final byte. */
const TAMPERED_COMMITMENT = '0xce99fc040a03fb82d617b61fce60933590049b003b7b5b989f7c3681f1b3fca4';

const EXPECTED = {
  credential: 'E71jA1xf49cCJFVcvDxhqm8eDDF6mcf8VFgoCaWfpSen',
  schema: 'GpmsvJCNeKBkuwm25vY9vjzh89ojaqCiNActrZAq1EKC',
  attestation: '36A3Fyeid2fauHVs1atAvc8YFvt7tvDSMqofZaeYYQbM',
  attestationMint: '4q5SUtLBMRZztPTHdHK3QdDCjyPoezUiKpBdTpvvjtFq',
  tokenAccount: 'EmZ7C7a8KY1DqGvqH9yEAsCbrioQAXpB6zdTtwKvcSLG',
} as const;

const reachable = await isReachable(rpc);
if (!reachable) console.warn(`mainnet read tests skipped: ${RPC_URL} unreachable`);

describe.skipIf(!reachable)('mainnet reference', () => {
  it('derives the published addresses from the issuer pubkey alone', async () => {
    const issuer = await deriveIssuerAddresses(ISSUER);
    const reference = await deriveReferenceAddresses(issuer, SUBJECT);
    expect(issuer.credential).toBe(EXPECTED.credential);
    expect(issuer.schema).toBe(EXPECTED.schema);
    expect(reference.attestation).toBe(EXPECTED.attestation);
    expect(reference.attestationMint).toBe(EXPECTED.attestationMint);
    expect(reference.recipientTokenAccount).toBe(EXPECTED.tokenAccount);
  });

  it('anchors the commitment the other two chains anchor', async () => {
    const result = await verify({
      rpc,
      issuerAuthority: ISSUER,
      subject: SUBJECT,
      referenceId: REFERENCE_ID,
      commitment: COMMITMENT,
    });

    // `expired` once the reference lapses on 2026-12-03; still a passing anchor.
    expect(['valid', 'expired']).toContain(result.status);
    expect(result.onchain?.commitment).toBe(COMMITMENT);
    expect(result.onchain?.referenceId).toBe(REFERENCE_ID);
    expect(result.onchain?.derivationId).toBe(DERIVATION_ID);
    expect(result.onchain?.tierCount).toBe(2);
    expect(result.attestation).toBe(EXPECTED.attestation);
    expect(result.tokenAccount).toBe(EXPECTED.tokenAccount);
    expect(result.schemaPaused).toBe(false);
    expect(result.schemaMatchesExpected).toBe(true);
  });

  it('rejects a claim set with one hex digit changed', async () => {
    // The negative control, run against the live chain rather than a fixture.
    const result = await verify({
      rpc,
      issuerAuthority: ISSUER,
      subject: SUBJECT,
      referenceId: REFERENCE_ID,
      commitment: TAMPERED_COMMITMENT,
    });
    expect(result.status).toBe('commitment-mismatch');
    expect(result.detail).toContain(COMMITMENT);
  });

  it('holds exactly one soulbound token at the subject account', async () => {
    const { value } = await rpc
      .getTokenAccountBalance(address(EXPECTED.tokenAccount))
      .send();
    expect(value.amount).toBe('1');
    expect(value.decimals).toBe(0);
  });

  it('keeps the extensions that make revocation possible', async () => {
    const { value } = await rpc
      .getAccountInfo(address(EXPECTED.attestationMint), { encoding: 'jsonParsed' })
      .send();
    expect(value).not.toBeNull();

    const parsed = value as unknown as {
      data: { parsed: { info: { extensions?: { extension: string }[] } } };
    };
    const extensions = new Set(
      (parsed.data.parsed.info.extensions ?? []).map((e) => e.extension),
    );
    // NonTransferable pins it to the checked address; the other two are what let the
    // issuer burn and close it without the subject's signature.
    expect(extensions).toContain('nonTransferable');
    expect(extensions).toContain('permanentDelegate');
    expect(extensions).toContain('mintCloseAuthority');
  });
});

async function isReachable(client: SolanaRpc): Promise<boolean> {
  try {
    await client.getLatestBlockhash().send();
    return true;
  } catch {
    return false;
  }
}
