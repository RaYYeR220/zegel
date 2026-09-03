import { describe, expect, it } from 'vitest';

import { createGatewayApp } from '../src/app.ts';

import { ALICE_NODE, dataCallData, makeConfig, RESOLVER, seedEnvelope } from './helpers.ts';

/**
 * ENSIP-22 requires a resolver's gateway to serve CORS, and the failure without it
 * is invisible: the browser blocks the request before any gateway code runs, so the
 * only symptom a wallet user sees is a name that will not resolve.
 */
describe('CORS', () => {
  it('answers a preflight from any origin', async () => {
    const response = await createGatewayApp(makeConfig()).request(`/v1/${RESOLVER}`, {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://app.ens.domains',
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'content-type',
      },
    });

    expect(response.status).toBeLessThan(300);
    expect(response.headers.get('access-control-allow-origin')).toBe('*');
    expect(response.headers.get('access-control-allow-methods')).toContain('POST');
    expect(response.headers.get('access-control-allow-headers')?.toLowerCase()).toContain('content-type');
  });

  it('allows any origin on the lookup response itself', async () => {
    const config = makeConfig();
    await seedEnvelope(config);

    const response = await createGatewayApp(config).request(
      `/v1/${RESOLVER}/${dataCallData(ALICE_NODE)}`,
      { headers: { Origin: 'https://example.invalid' } },
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('access-control-allow-origin')).toBe('*');
  });

  it('allows any origin on an error response too', async () => {
    const response = await createGatewayApp(makeConfig()).request(`/v1/${RESOLVER}/0xdeadbeef`, {
      headers: { Origin: 'https://example.invalid' },
    });

    // A CORS-blocked 400 reaches the client as an opaque network failure, which is
    // the hardest kind of gateway bug to diagnose from a wallet.
    expect(response.status).toBe(400);
    expect(response.headers.get('access-control-allow-origin')).toBe('*');
  });
});
