import {
  decodeAbiParameters,
  encodeAbiParameters,
  recoverAddress,
  size,
  slice,
  stringToHex,
  type Hex,
} from 'viem';
import { describe, expect, it } from 'vitest';

import { createGatewayApp } from '../src/app.ts';
import { makeSignatureHash } from '../src/signing.ts';

import {
  ALICE,
  ALICE_NODE,
  BOB,
  BOB_NODE,
  dataCallData,
  dnsEncode,
  envelopeText,
  FIXED_NOW,
  gatewaySigner,
  makeConfig,
  RESOLVER,
  resolveCallData,
  seedEnvelope,
} from './helpers.ts';

interface DecodedResponse {
  result: Hex;
  expires: bigint;
  signature: Hex;
}

function decodeResponse(data: Hex): DecodedResponse {
  const [result, expires, signature] = decodeAbiParameters(
    [{ type: 'bytes' }, { type: 'uint64' }, { type: 'bytes' }],
    data,
  );
  return { result, expires, signature };
}

async function get(path: string, config = makeConfig()): Promise<Response> {
  return createGatewayApp(config).request(path);
}

/** Builds `resolve(name, request)` calldata from parts, including invalid ones. */
function wrapResolve(name: Hex, request: Hex): Hex {
  return `0x9061b923${encodeAbiParameters(
    [{ type: 'bytes' }, { type: 'bytes' }],
    [name, request],
  ).slice(2)}`;
}

describe('GET /v1/:sender/:data', () => {
  it('serves a signed envelope for a direct data() query', async () => {
    const config = makeConfig();
    await seedEnvelope(config);
    const callData = dataCallData(ALICE_NODE);

    const response = await createGatewayApp(config).request(`/v1/${RESOLVER}/${callData}`);
    expect(response.status).toBe(200);

    const body = (await response.json()) as { data: Hex };
    const { result, expires, signature } = decodeResponse(body.data);

    // data() returns bytes, so the result is the envelope itself, unwrapped.
    expect(result).toBe(stringToHex(envelopeText()));
    expect(expires).toBe(BigInt(FIXED_NOW + config.signatureTtlSeconds));
    expect(size(signature)).toBe(65);

    const recovered = await recoverAddress({
      hash: makeSignatureHash(RESOLVER, expires, callData, result),
      signature,
    });
    expect(recovered).toBe(gatewaySigner.address);
  });

  it('accepts the .json suffix deployed resolvers template into their url()', async () => {
    const config = makeConfig();
    await seedEnvelope(config);

    const response = await createGatewayApp(config).request(
      `/v1/${RESOLVER}/${dataCallData(ALICE_NODE)}.json`,
    );
    expect(response.status).toBe(200);
  });

  it('wraps the result one layer deeper for a resolve() query', async () => {
    const config = makeConfig();
    await seedEnvelope(config);
    const callData = resolveCallData(ALICE, ALICE_NODE);

    const response = await createGatewayApp(config).request(`/v1/${RESOLVER}/${callData}`);
    const body = (await response.json()) as { data: Hex };
    const { result } = decodeResponse(body.data);

    // resolve() returns the ABI-encoded return of the inner call, not the inner value.
    const [inner] = decodeAbiParameters([{ type: 'bytes' }], result);
    expect(inner).toBe(stringToHex(envelopeText()));
    expect(result).not.toBe(inner);
  });

  it('caps the signature expiry at the envelope own expiry', async () => {
    const config = makeConfig({ signatureTtlSeconds: 600 });
    const expiresAt = new Date((FIXED_NOW + 60) * 1000).toISOString();
    await seedEnvelope(config, ALICE_NODE, { expiresAt });

    const response = await createGatewayApp(config).request(`/v1/${RESOLVER}/${dataCallData(ALICE_NODE)}`);
    const body = (await response.json()) as { data: Hex };
    expect(decodeResponse(body.data).expires).toBe(BigInt(FIXED_NOW + 60));
  });

  it('never caches a response for longer than its signature is valid', async () => {
    const config = makeConfig({ signatureTtlSeconds: 60, cacheTtlSeconds: 30 });
    await seedEnvelope(config);

    const response = await createGatewayApp(config).request(`/v1/${RESOLVER}/${dataCallData(ALICE_NODE)}`);
    const header = response.headers.get('cache-control') ?? '';
    const maxAge = Number(/max-age=(\d+)/.exec(header)?.[1]);
    expect(maxAge).toBeLessThanOrEqual(config.signatureTtlSeconds);
    expect(maxAge).toBe(30);
  });
});

describe('POST /v1', () => {
  it('serves the same signed response as GET', async () => {
    const config = makeConfig();
    await seedEnvelope(config);
    const callData = dataCallData(ALICE_NODE);
    const app = createGatewayApp(config);

    const viaGet = (await (await app.request(`/v1/${RESOLVER}/${callData}`)).json()) as { data: Hex };
    const viaPost = (await (
      await app.request(`/v1/${RESOLVER}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ data: callData, sender: RESOLVER }),
      })
    ).json()) as { data: Hex };

    // Signing is RFC 6979 deterministic, so the two shapes are byte-identical.
    expect(viaPost.data).toBe(viaGet.data);
  });

  it('accepts a body-only request, for a url() template with no placeholders', async () => {
    const config = makeConfig();
    await seedEnvelope(config);

    const response = await createGatewayApp(config).request('/v1', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ data: dataCallData(ALICE_NODE), sender: RESOLVER }),
    });
    expect(response.status).toBe(200);
  });

  it('rejects a body whose sender disagrees with the path', async () => {
    const config = makeConfig();
    await seedEnvelope(config);

    const response = await createGatewayApp(config).request(`/v1/${RESOLVER}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        data: dataCallData(ALICE_NODE),
        sender: '0x0000000000000000000000000000000000000009',
      }),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ message: expect.stringContaining('does not match') });
  });

  it('rejects a body that is not JSON', async () => {
    const response = await createGatewayApp(makeConfig()).request(`/v1/${RESOLVER}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'not json',
    });
    expect(response.status).toBe(400);
  });
});

describe('malformed calldata', () => {
  it('rejects data that is not hex', async () => {
    const response = await get(`/v1/${RESOLVER}/hello`);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ message: expect.stringContaining('hex') });
  });

  it('rejects calldata shorter than a selector', async () => {
    const response = await get(`/v1/${RESOLVER}/0x1234`);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ message: expect.stringContaining('selector') });
  });

  it('rejects an unknown selector', async () => {
    const response = await get(`/v1/${RESOLVER}/0xdeadbeef`);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      message: expect.stringContaining('unsupported callData selector'),
    });
  });

  it('rejects truncated data() arguments', async () => {
    const truncated = slice(dataCallData(ALICE_NODE), 0, 20);
    const response = await get(`/v1/${RESOLVER}/${truncated}`);
    expect(response.status).toBe(400);
  });

  it('rejects a resolve() wrapping a record type this resolver does not serve', async () => {
    // resolve(name, addr(node)) — a perfectly normal ENS query, and not ours.
    const addrCall = `0x3b3b57de${ALICE_NODE.slice(2)}` as Hex;
    const response = await get(`/v1/${RESOLVER}/${wrapResolve(dnsEncode(ALICE), addrCall)}`);

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      message: expect.stringContaining('ENSIP-24 data(bytes32,string)'),
    });
  });

  it('rejects a node that is not the namehash of the name it travels with', async () => {
    const mismatched = wrapResolve(dnsEncode(ALICE), dataCallData(BOB_NODE));
    const response = await get(`/v1/${RESOLVER}/${mismatched}`);

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      message: expect.stringContaining('is not the namehash of'),
    });
  });

  it('rejects a DNS name that is not terminated', async () => {
    // 0x05 "alice" with no root label after it.
    const unterminated = wrapResolve('0x05616c696365', dataCallData(ALICE_NODE));
    const response = await get(`/v1/${RESOLVER}/${unterminated}`);

    expect(response.status).toBe(400);
  });

  it('rejects a sender that is not an address', async () => {
    const response = await get(`/v1/notanaddress/${dataCallData(ALICE_NODE)}`);
    expect(response.status).toBe(400);
  });
});

describe('refusals', () => {
  it('404s a node with no published envelope', async () => {
    const config = makeConfig();
    await seedEnvelope(config, ALICE_NODE);

    const response = await createGatewayApp(config).request(
      `/v1/${RESOLVER}/${resolveCallData(BOB, BOB_NODE)}`,
    );
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({
      message: expect.stringContaining('no envelope published'),
    });
  });

  it('404s a data key it does not serve', async () => {
    const config = makeConfig();
    await seedEnvelope(config);

    const response = await createGatewayApp(config).request(
      `/v1/${RESOLVER}/${dataCallData(ALICE_NODE, 'com.twitter')}`,
    );
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ message: expect.stringContaining('com.twitter') });
  });

  it('404s a resolver it does not sign for', async () => {
    const config = makeConfig();
    await seedEnvelope(config);

    const response = await createGatewayApp(config).request(
      `/v1/0x0000000000000000000000000000000000000009/${dataCallData(ALICE_NODE)}`,
    );
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({
      message: expect.stringContaining('does not serve resolver'),
    });
  });

  it('signs for any resolver when no allowlist is configured', async () => {
    const config = makeConfig({ resolvers: [] });
    await seedEnvelope(config);

    const response = await createGatewayApp(config).request(
      `/v1/0x0000000000000000000000000000000000000009/${dataCallData(ALICE_NODE)}`,
    );
    expect(response.status).toBe(200);
  });

  it('410s an envelope whose own expiry has passed', async () => {
    const config = makeConfig();
    await seedEnvelope(config, ALICE_NODE, {
      issuedAt: new Date((FIXED_NOW - 7200) * 1000).toISOString(),
      expiresAt: new Date((FIXED_NOW - 60) * 1000).toISOString(),
    });

    const response = await createGatewayApp(config).request(`/v1/${RESOLVER}/${dataCallData(ALICE_NODE)}`);
    expect(response.status).toBe(410);
    expect(await response.json()).toMatchObject({
      message: expect.stringContaining('no signable response exists'),
    });
  });

  it('serves an envelope right up to its expiry second and refuses it after', async () => {
    const clock = { seconds: FIXED_NOW };
    const config = makeConfig({ clock });
    const expiresAt = new Date((FIXED_NOW + 1) * 1000).toISOString();
    await seedEnvelope(config, ALICE_NODE, { expiresAt });
    const app = createGatewayApp(config);

    expect((await app.request(`/v1/${RESOLVER}/${dataCallData(ALICE_NODE)}`)).status).toBe(200);
    clock.seconds = FIXED_NOW + 1;
    expect((await app.request(`/v1/${RESOLVER}/${dataCallData(ALICE_NODE)}`)).status).toBe(410);
  });
});
