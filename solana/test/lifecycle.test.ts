/**
 * Issuer-side guards, exercised against served account bytes.
 *
 * These are the refusals: the cases where the right behaviour is to stop rather than
 * to send a transaction. They are cheap to get wrong and expensive to notice.
 */

import { describe, expect, it } from 'vitest';
import { address } from '@solana/kit';
import { createIssuer } from '../src/issuer.ts';
import { issue } from '../src/issue.ts';
import { close, revoke } from '../src/revoke.ts';
import { verify } from '../src/verify.ts';
import { deriveIssuerAddresses, deriveReferenceAddresses } from '../src/pdas.ts';
import { encodeFieldNames, encodeReferenceData, SchemaDriftError } from '../src/schema.ts';
import {
  AttestationExistsError,
  AttestationNotExpiredError,
  AttestationNotFoundError,
  ReferenceMismatchError,
} from '../src/errors.ts';
import {
  attestationAccountBytes,
  COMMITMENT,
  DERIVATION_ID,
  fakeRpc,
  ISSUER_AUTHORITY,
  REFERENCE_ID,
  schemaAccountBytes,
  SUBJECT,
} from './fixtures.ts';
import type { ZegelIssuerContext } from '../src/context.ts';
import type { SolanaRpc } from '../src/rpc.ts';

/**
 * RFC 8032 ed25519 test vector 1: a 32-byte zero seed and its matching public key.
 * Kit validates that the two halves agree, so an arbitrary 64 zero bytes is rejected.
 * This key signs nothing here — every test that uses it stops before a send.
 */
const TEST_KEYPAIR = Uint8Array.from([
  ...new Array(32).fill(0),
  0x3b, 0x6a, 0x27, 0xbc, 0xce, 0xb6, 0xa4, 0x2d, 0x62, 0xa3, 0xa8, 0xd0, 0x2a, 0x6f, 0x0d, 0x73,
  0x65, 0x32, 0x15, 0x77, 0x1d, 0xe2, 0x43, 0xa6, 0x3a, 0xc0, 0x48, 0xa1, 0x8b, 0x59, 0xda, 0x29,
]);
const FUTURE = 1_893_456_000n; // 2030-01-01
const PAST = 1_600_000_000n; // 2020-09-13

async function issuerWith(rpc: SolanaRpc): Promise<ZegelIssuerContext> {
  const handle = await createIssuer({ rpcUrl: 'http://unused', keypair: TEST_KEYPAIR, skipSetup: true });
  // Swap in the served accounts, and pin the authority so derivations are stable.
  return {
    ...handle,
    rpc,
    addresses: await deriveIssuerAddresses(ISSUER_AUTHORITY),
  };
}

async function servedState(options: {
  expiry?: bigint;
  anchoredReferenceId?: string;
  omitAttestation?: boolean;
  omitSchemaMint?: boolean;
  driftedSchema?: boolean;
}) {
  const addresses = await deriveIssuerAddresses(ISSUER_AUTHORITY);
  const reference = await deriveReferenceAddresses(addresses, SUBJECT);
  const accounts: Record<string, Uint8Array> = {
    [addresses.schema]: schemaAccountBytes({
      credential: addresses.credential,
      ...(options.driftedSchema
        ? { fieldNames: encodeFieldNames(['a', 'b', 'c', 'd', 'e']) }
        : {}),
    }),
  };
  if (!options.omitSchemaMint) accounts[addresses.schemaMint] = new Uint8Array(234);
  if (!options.omitAttestation) {
    accounts[reference.attestation] = attestationAccountBytes({
      nonce: SUBJECT,
      credential: addresses.credential,
      schema: addresses.schema,
      signer: ISSUER_AUTHORITY,
      expiry: options.expiry ?? FUTURE,
      tokenAccount: reference.recipientTokenAccount,
      data: encodeReferenceData({
        referenceId: options.anchoredReferenceId ?? REFERENCE_ID,
        commitment: COMMITMENT,
        expiresAt: options.expiry ?? FUTURE,
        derivationId: DERIVATION_ID,
        tierCount: 2,
      }),
    });
  }
  return { addresses, reference, rpc: fakeRpc({ accounts }) };
}

describe('issue guards', () => {
  it('refuses a second reference for a subject who already holds one', async () => {
    const { rpc } = await servedState({});
    const issuer = await issuerWith(rpc);
    await expect(
      issue({
        issuer,
        subject: SUBJECT,
        referenceId: `0x${'22'.repeat(32)}`,
        commitment: COMMITMENT,
        expiresAt: FUTURE,
        derivationId: DERIVATION_ID,
      }),
    ).rejects.toThrow(AttestationExistsError);
  });

  it('names the reference already anchored there', async () => {
    const { rpc } = await servedState({});
    const issuer = await issuerWith(rpc);
    await expect(
      issue({
        issuer,
        subject: SUBJECT,
        referenceId: `0x${'22'.repeat(32)}`,
        commitment: COMMITMENT,
        expiresAt: FUTURE,
        derivationId: DERIVATION_ID,
      }),
    ).rejects.toThrow(REFERENCE_ID);
  });

  it('refuses to issue against an uninitialised issuer', async () => {
    const { rpc } = await servedState({ omitSchemaMint: true, omitAttestation: true });
    const issuer = await issuerWith(rpc);
    await expect(
      issue({
        issuer,
        subject: SUBJECT,
        referenceId: REFERENCE_ID,
        commitment: COMMITMENT,
        expiresAt: FUTURE,
        derivationId: DERIVATION_ID,
      }),
    ).rejects.toThrow(/does not exist/);
  });

  it('refuses to issue against a schema whose layout drifted', async () => {
    const { rpc } = await servedState({ driftedSchema: true, omitAttestation: true });
    const issuer = await issuerWith(rpc);
    await expect(
      issue({
        issuer,
        subject: SUBJECT,
        referenceId: REFERENCE_ID,
        commitment: COMMITMENT,
        expiresAt: FUTURE,
        derivationId: DERIVATION_ID,
      }),
    ).rejects.toThrow(SchemaDriftError);
  });

  it('rejects malformed identifiers before any network call', async () => {
    const issuer = await issuerWith(fakeRpc({ accounts: {} }));
    await expect(
      issue({
        issuer,
        subject: SUBJECT,
        referenceId: 'nope',
        commitment: COMMITMENT,
        expiresAt: FUTURE,
        derivationId: DERIVATION_ID,
      }),
    ).rejects.toThrow(/referenceId/);
  });
});

describe('close and revoke guards', () => {
  it('close refuses a reference that has not expired', async () => {
    const { rpc } = await servedState({ expiry: FUTURE });
    const issuer = await issuerWith(rpc);
    await expect(close({ issuer, subject: SUBJECT })).rejects.toThrow(AttestationNotExpiredError);
  });

  it('close refuses a reference with no expiry at all', async () => {
    // Expiry 0 is "never lapses". Read as a timestamp it would look like 1970 and
    // close() would silently revoke a permanent reference.
    const { rpc } = await servedState({ expiry: 0n });
    const issuer = await issuerWith(rpc);
    await expect(close({ issuer, subject: SUBJECT })).rejects.toThrow(/never expires/);
  });

  it('refuses when the supplied reference id is not the one anchored', async () => {
    const { rpc } = await servedState({ expiry: PAST });
    const issuer = await issuerWith(rpc);
    await expect(
      revoke({ issuer, subject: SUBJECT, referenceId: `0x${'33'.repeat(32)}` }),
    ).rejects.toThrow(ReferenceMismatchError);
  });

  it('refuses when there is nothing to close', async () => {
    const { rpc } = await servedState({ omitAttestation: true });
    const issuer = await issuerWith(rpc);
    await expect(revoke({ issuer, subject: SUBJECT })).rejects.toThrow(AttestationNotFoundError);
  });
});

describe('verify against a drifted schema', () => {
  it('fails by name rather than returning a plausible answer', async () => {
    const addresses = await deriveIssuerAddresses(ISSUER_AUTHORITY);
    const reference = await deriveReferenceAddresses(addresses, SUBJECT);
    const rpc = fakeRpc({
      accounts: {
        // Field names the codec cannot map onto our payload.
        [addresses.schema]: schemaAccountBytes({
          credential: addresses.credential,
          fieldNames: encodeFieldNames(['a', 'b', 'c', 'd', 'e']),
        }),
        [reference.attestation]: attestationAccountBytes({
          nonce: SUBJECT,
          credential: addresses.credential,
          schema: addresses.schema,
          signer: ISSUER_AUTHORITY,
          expiry: FUTURE,
          tokenAccount: reference.recipientTokenAccount,
          data: encodeReferenceData({
            referenceId: REFERENCE_ID,
            commitment: COMMITMENT,
            expiresAt: FUTURE,
            derivationId: DERIVATION_ID,
            tierCount: 2,
          }),
        }),
      },
    });

    await expect(
      verify({
        rpc,
        issuerAuthority: ISSUER_AUTHORITY,
        subject: SUBJECT,
        referenceId: REFERENCE_ID,
        commitment: COMMITMENT,
      }),
    ).rejects.toThrow(SchemaDriftError);
  });
});

describe('createIssuer', () => {
  it('derives the same addresses whether or not setup runs', async () => {
    const handle = await createIssuer({
      rpcUrl: 'http://unused',
      keypair: TEST_KEYPAIR,
      skipSetup: true,
    });
    expect(handle.setup.created).toEqual({ credential: false, schema: false, schemaMint: false });
    expect(handle.setup.signature).toBeNull();
    expect(handle.addresses).toEqual(await deriveIssuerAddresses(handle.authority.address));
  });

  it('accepts a raw 64-byte keypair and rejects anything else', async () => {
    await expect(
      createIssuer({ rpcUrl: 'http://unused', keypair: new Uint8Array(32), skipSetup: true }),
    ).rejects.toThrow(TypeError);
  });

  it('sends nothing when the credential, schema and mint are all live', async () => {
    const calls: string[] = [];
    const addresses = await deriveIssuerAddresses(ISSUER_AUTHORITY);
    const rpc = fakeRpc({
      accounts: {
        [addresses.credential]: new Uint8Array(78),
        [addresses.schema]: schemaAccountBytes({ credential: addresses.credential }),
        [addresses.schemaMint]: new Uint8Array(234),
      },
      calls,
    });
    const { setupIssuer } = await import('../src/issuer.ts');
    const result = await setupIssuer(await issuerWith(rpc));
    expect(result.created).toEqual({ credential: false, schema: false, schemaMint: false });
    expect(result.signature).toBeNull();
    expect(calls.some((c) => c.startsWith('getLatestBlockhash'))).toBe(false);
  });

  it('refuses to proceed when the live schema layout drifted', async () => {
    const addresses = await deriveIssuerAddresses(ISSUER_AUTHORITY);
    const rpc = fakeRpc({
      accounts: {
        [addresses.credential]: new Uint8Array(78),
        [addresses.schema]: schemaAccountBytes({
          credential: addresses.credential,
          layout: Uint8Array.from([13, 13, 3, 13, 3]),
        }),
        [addresses.schemaMint]: new Uint8Array(234),
      },
    });
    const { setupIssuer } = await import('../src/issuer.ts');
    await expect(setupIssuer(await issuerWith(rpc))).rejects.toThrow(SchemaDriftError);
  });
});

describe('address inputs', () => {
  it('accepts a subject given as a plain string', async () => {
    const { rpc } = await servedState({});
    const issuer = await issuerWith(rpc);
    await expect(
      revoke({ issuer, subject: String(SUBJECT), referenceId: `0x${'33'.repeat(32)}` }),
    ).rejects.toThrow(ReferenceMismatchError);
  });

  it('rejects a subject that is not a valid address', async () => {
    const { rpc } = await servedState({});
    const issuer = await issuerWith(rpc);
    await expect(revoke({ issuer, subject: 'not-an-address' })).rejects.toThrow();
    expect(() => address('not-an-address')).toThrow();
  });
});
