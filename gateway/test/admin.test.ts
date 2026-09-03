import { describe, expect, it } from 'vitest';

import { createGatewayApp } from '../src/app.ts';

import {
  ALICE_NODE,
  BOB_NODE,
  dataCallData,
  envelopeText,
  FIXED_NOW,
  makeConfig,
  publishBody,
  RESOLVER,
  strangerAccount,
  ownerAccount,
} from './helpers.ts';

async function publish(config = makeConfig(), body?: Record<string, unknown>): Promise<Response> {
  return createGatewayApp(config).request('/admin/envelopes', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? (await publishBody(config))),
  });
}

describe('POST /admin/envelopes', () => {
  it('accepts a publish signed by the name owner and serves it immediately', async () => {
    const config = makeConfig();
    const app = createGatewayApp(config);

    const created = await app.request('/admin/envelopes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(await publishBody(config, { name: 'alice.eth' })),
    });
    expect(created.status).toBe(201);
    expect(await created.json()).toMatchObject({
      node: ALICE_NODE.toLowerCase(),
      name: 'alice.eth',
      publisher: ownerAccount.address,
      nonce: '1',
    });

    const resolved = await app.request(`/v1/${RESOLVER}/${dataCallData(ALICE_NODE)}`);
    expect(resolved.status).toBe(200);
  });

  it('refuses a publish signed by anyone but the owner', async () => {
    const config = makeConfig();
    const response = await publish(config, await publishBody(config, { signWith: strangerAccount }));

    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({
      message: expect.stringContaining(ownerAccount.address),
    });
  });

  it('refuses a name whose owner it cannot establish', async () => {
    const config = makeConfig();
    const response = await publish(config, await publishBody(config, { node: BOB_NODE }));

    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ message: expect.stringContaining('no owner known') });
  });

  it('refuses an authorisation whose validUntil has passed', async () => {
    const config = makeConfig();
    const response = await publish(
      config,
      await publishBody(config, { validUntil: BigInt(FIXED_NOW - 1) }),
    );

    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ message: expect.stringContaining('expired') });
  });

  it('refuses an authorisation valid for longer than a publish needs', async () => {
    const config = makeConfig();
    const response = await publish(
      config,
      await publishBody(config, { validUntil: BigInt(FIXED_NOW + 86_400) }),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      message: expect.stringContaining('standing permission'),
    });
  });

  /**
   * The rollback attack. A publish is a signed message, so anyone who saw an earlier
   * one can re-submit it; without a monotonic nonce that would revert the name to a
   * superseded envelope — which is exactly how you un-revoke a revoked reference.
   */
  it('refuses to replay a publish, or to go backwards', async () => {
    const config = makeConfig();
    const app = createGatewayApp(config);

    const first = await publishBody(config, { nonce: 2n });
    expect((await publish(config, first)).status).toBe(201);

    const replayed = await app.request('/admin/envelopes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(first),
    });
    expect(replayed.status).toBe(409);
    expect(await replayed.json()).toMatchObject({ message: expect.stringContaining('not above') });

    const older = await publishBody(config, { nonce: 1n });
    expect((await publish(config, older)).status).toBe(409);

    const newer = await publishBody(config, { nonce: 3n });
    expect((await publish(config, newer)).status).toBe(201);
  });

  it('refuses a signature bound to a different gateway operator', async () => {
    const config = makeConfig();
    const response = await publish(
      config,
      await publishBody(config, { gateway: '0x000000000000000000000000000000000000dEaD' }),
    );

    expect(response.status).toBe(401);
  });

  it('refuses a signature bound to a different chain', async () => {
    const config = makeConfig();
    const response = await publish(config, await publishBody(config, { chainId: 8453 }));

    expect(response.status).toBe(401);
  });

  it('refuses an envelope that has already expired', async () => {
    const config = makeConfig();
    const expired = envelopeText({
      issuedAt: new Date((FIXED_NOW - 7200) * 1000).toISOString(),
      expiresAt: new Date((FIXED_NOW - 60) * 1000).toISOString(),
    });
    const response = await publish(config, await publishBody(config, { envelope: expired }));

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      message: expect.stringContaining('resolves to nothing'),
    });
  });

  it('refuses an envelope of the wrong schema', async () => {
    const config = makeConfig();
    const wrong = JSON.stringify({ ...JSON.parse(envelopeText()), schema: 'something.else' });
    const response = await publish(config, await publishBody(config, { envelope: wrong }));

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ message: expect.stringContaining('schema') });
  });

  it('refuses an envelope missing a tier', async () => {
    const config = makeConfig();
    const wrong = JSON.stringify({ ...JSON.parse(envelopeText()), tiers: [] });
    const response = await publish(config, await publishBody(config, { envelope: wrong }));

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ message: expect.stringContaining('tiers') });
  });

  it('refuses a body missing the signature', async () => {
    const config = makeConfig();
    const { signature: _signature, ...rest } = await publishBody(config);
    const response = await publish(config, rest);

    expect(response.status).toBe(400);
  });
});

describe('GET /envelopes/:node', () => {
  it('returns the published envelope as JSON, unsigned', async () => {
    const config = makeConfig();
    const app = createGatewayApp(config);
    await app.request('/admin/envelopes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(await publishBody(config)),
    });

    const response = await app.request(`/envelopes/${ALICE_NODE}`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      node: ALICE_NODE.toLowerCase(),
      expired: false,
      envelope: JSON.parse(envelopeText()),
    });
  });

  it('404s an unpublished node', async () => {
    const response = await createGatewayApp(makeConfig()).request(`/envelopes/${BOB_NODE}`);
    expect(response.status).toBe(404);
  });

  it('400s something that is not a node', async () => {
    const response = await createGatewayApp(makeConfig()).request('/envelopes/0x00');
    expect(response.status).toBe(400);
  });
});
