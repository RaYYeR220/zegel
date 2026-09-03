import { describe, expect, it } from 'vitest';

import { SWARM_GATEWAY_URL, backendEnvDefaults, connectBackend } from '../src/backend.js';
import { SealClient } from '../src/client.js';
import { decodeEnvelope } from '../src/envelope.js';
import { GranteeManagementUnavailableError } from '../src/errors.js';
import { memoryKeeper } from '../src/keeper.js';
import { granteeFromPrivateKey } from '../src/pubkey.js';
import { coordinatesOf } from '../src/receipt.js';

/**
 * Live integration against the real public Swarm gateway.
 *
 * Nothing here is mocked. The point is that the privacy claim is checked against
 * the network rather than against a fixture: if the gateway ever starts answering
 * an un-credentialed ACT read with anything other than 404, this fails.
 *
 * Skipped when the gateway is unreachable, so an offline machine still gets a
 * green suite — but never skipped by asserting less.
 */

const env = backendEnvDefaults();
const GATEWAY_URL = env.gatewayUrl;

const online = await fetch(new URL('/health', GATEWAY_URL), {
  signal: AbortSignal.timeout(5_000),
})
  .then((response) => response.ok)
  .catch(() => false);

const nodeOnline = await fetch(new URL('/health', env.nodeUrl), { signal: AbortSignal.timeout(1_000) })
  .then((response) => response.ok)
  .catch(() => false);

const REFERENCE_ID = `0x${'7'.repeat(64)}`;

const PAYLOAD = {
  schema: 'zegel.claims.v1',
  referenceId: REFERENCE_ID,
  claims: [{ id: 'realized-pnl-usd-90d', passed: true }],
  note: 'live gateway integration',
};

describe.skipIf(!online)('public Swarm gateway, live', () => {
  it('reports what it can and cannot do, without pretending', async () => {
    const backend = await connectBackend({ kind: 'gateway', url: GATEWAY_URL });

    expect(backend.caps.kind).toBe('gateway');
    expect(backend.caps.usesNullStamp).toBe(true);
    expect(backend.caps.canManageGrantees).toBe(false);
    expect(backend.caps.canManagePostage).toBe(false);
    expect(backend.caps.confidentiality).toBe('obscurity');
    expect(backend.batchId).toBe('0'.repeat(64));
    expect(backend.caps.limitations.join(' ')).toMatch(/grantee/i);
  });

  it('seals with no node, no stamp and no tokens, and returns a history address', async () => {
    const backend = await connectBackend({ kind: 'gateway', url: GATEWAY_URL });
    const keep = memoryKeeper();
    const client = new SealClient(backend, { keep });

    const receipt = await client.seal(PAYLOAD, [], { referenceId: REFERENCE_ID, tier: 1 });

    expect(receipt.swarmRef).toMatch(/^[0-9a-f]{64}$/);
    expect(receipt.actHistoryAddress).toMatch(/^[0-9a-f]{64}$/);
    expect(receipt.backend).toBe('gateway');
    expect(keep.receipts).toHaveLength(1);
  });

  it('answers an un-credentialed read with 404, indistinguishable from absent', async () => {
    const backend = await connectBackend({ kind: 'gateway', url: GATEWAY_URL });
    const client = new SealClient(backend, { keep: memoryKeeper() });
    const receipt = await client.seal(PAYLOAD, [], { referenceId: REFERENCE_ID });

    const sealed = await fetch(`${GATEWAY_URL}/bytes/${receipt.swarmRef}`);
    const neverExisted = await fetch(`${GATEWAY_URL}/bytes/${'9'.repeat(64)}`);

    expect(sealed.status).toBe(404);
    expect(neverExisted.status).toBe(404);
    expect(await sealed.json()).toEqual(await neverExisted.json());
  });

  it('refuses to grant on a backend whose /grantee is not exposed', async () => {
    const backend = await connectBackend({ kind: 'gateway', url: GATEWAY_URL });
    const client = new SealClient(backend, { keep: memoryKeeper() });

    await expect(
      client.seal(PAYLOAD, [granteeFromPrivateKey(`0x${'0a'.repeat(32)}`)], { referenceId: REFERENCE_ID }),
    ).rejects.toThrowError(GranteeManagementUnavailableError);

    const raw = await fetch(`${GATEWAY_URL}/grantee`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'swarm-postage-batch-id': '0'.repeat(64) },
      body: JSON.stringify({ grantees: [granteeFromPrivateKey(`0x${'0a'.repeat(32)}`)] }),
    });
    expect(raw.status).toBe(404);
  });

  it('does not expose a publisher key, so the round trip needs our own node', async () => {
    // The documented limitation, asserted rather than asserted-in-prose: the
    // gateway 404s /addresses, so the ACT publisher for a gateway upload is
    // unknowable and the content cannot be read back through it.
    const addresses = await fetch(`${GATEWAY_URL}/addresses`);
    expect(addresses.status).toBe(404);

    const backend = await connectBackend({ kind: 'gateway', url: GATEWAY_URL });
    expect(backend.publisher).toBeNull();
    expect(backend.caps.canUnseal).toBe(false);
  });
});

describe.skipIf(!nodeOnline)('local Bee node, live', () => {
  it('seals and reads back as publisher, and 404s for a stranger', async () => {
    const backend = await connectBackend({ kind: 'node', url: env.nodeUrl });
    const client = new SealClient(backend, { keep: memoryKeeper() });

    const receipt = await client.seal(PAYLOAD, [], { referenceId: REFERENCE_ID });
    expect(receipt.actPublisher).toMatch(/^[0-9a-f]{66}$/);

    const asPublisher = await client.unseal<typeof PAYLOAD>(coordinatesOf(receipt));
    expect(asPublisher.granted).toBe(true);
    if (asPublisher.granted) expect(asPublisher.payload).toEqual(PAYLOAD);

    const asStranger = await fetch(`${env.nodeUrl}/bytes/${receipt.swarmRef}`);
    expect(asStranger.status).toBe(404);

    const raw = await fetch(`${env.nodeUrl}/bytes/${receipt.swarmRef}`, {
      headers: {
        'swarm-act-publisher': receipt.actPublisher as string,
        'swarm-act-history-address': receipt.actHistoryAddress,
      },
    });
    expect(raw.status).toBe(200);
    expect(decodeEnvelope(new Uint8Array(await raw.arrayBuffer())).payload).toEqual(PAYLOAD);
  });
});

describe('environment', () => {
  it('defaults to the gateway that accepts the all-zeros batch', () => {
    expect(backendEnvDefaults({}).gatewayUrl).toBe(SWARM_GATEWAY_URL);
    expect(backendEnvDefaults({}).nodeUrl).toBe('http://localhost:1633');
  });

  it('lets the environment override both endpoints', () => {
    const overridden = backendEnvDefaults({
      SWARM_GATEWAY_URL: 'https://swarm.example',
      ZEGEL_BEE_URL: 'http://127.0.0.1:1643',
      ZEGEL_POSTAGE_BATCH_ID: 'f'.repeat(64),
    });
    expect(overridden.gatewayUrl).toBe('https://swarm.example');
    expect(overridden.nodeUrl).toBe('http://127.0.0.1:1643');
    expect(overridden.batchId).toBe('f'.repeat(64));
  });
});
