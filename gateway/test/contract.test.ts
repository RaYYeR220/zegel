import { readFileSync } from 'node:fs';

import { serve, type ServerType } from '@hono/node-server';
import {
  createPublicClient,
  createWalletClient,
  decodeAbiParameters,
  encodeAbiParameters,
  http,
  stringToHex,
  type Abi,
  type Address,
  type Hex,
  type PublicClient,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { foundry } from 'viem/chains';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ENVELOPE_SCHEMA } from '../../packages/sdk/src/types.ts';
import { createGatewayApp } from '../src/app.ts';
import { encodeResponse } from '../src/ccip.ts';
import type { GatewayConfig } from '../src/config.ts';
import { buildHealthReport } from '../src/health.ts';

import { anvilAvailable, freePort, startAnvil, type AnvilHandle } from './anvil.ts';
import {
  ALICE,
  ALICE_NODE,
  BOB,
  BOB_NODE,
  dataCallData,
  dnsEncode,
  envelopeText,
  gatewaySigner,
  makeConfig,
  resolveCallData,
  seedEnvelope,
} from './helpers.ts';

/** anvil's first prefunded account. */
const DEPLOYER_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' as const;

/** The UniversalResolver a client actually reaches a mainnet resolver through. */
const UNIVERSAL_RESOLVER = '0xED73a03F19e8D849E44a39252d222c6ad5217E1e' as const;

interface ForgeArtifact {
  abi: Abi;
  bytecode: { object: Hex };
}

function loadArtifact(): ForgeArtifact | null {
  try {
    const path = new URL('../../contracts/out/ZegelResolver.sol/ZegelResolver.json', import.meta.url);
    return JSON.parse(readFileSync(path, 'utf8')) as ForgeArtifact;
  } catch {
    return null;
  }
}

const artifact = loadArtifact();
const runnable = artifact !== null && anvilAvailable();

/**
 * The cross-check that matters: everything else in this suite tests the gateway
 * against the gateway's own understanding of the resolver. This tests it against the
 * resolver.
 *
 * The compiled `ZegelResolver` is deployed to a local anvil, the gateway is started
 * on a real port and named in the resolver's `gatewayUrls()`, and viem is then asked
 * to read a record. viem follows the `OffchainLookup` revert, fetches this gateway
 * over HTTP, and feeds the response back through `resolveWithProof` — the whole
 * ERC-3668 round trip, through the same client stack a wallet uses. If the digest
 * layout, the `v` encoding, the `s` normalisation, the `expires` field or the
 * `data()`/`resolve()` result wrapping were wrong in any way, none of these pass.
 */
describe.skipIf(!runnable)('against the deployed ZegelResolver on anvil', () => {
  let anvil: AnvilHandle;
  let server: ServerType;
  let resolver: Address;
  let publicClient: PublicClient;
  let config: GatewayConfig;
  let gatewayPort: number;

  const abi = artifact?.abi ?? [];
  const envelope = stringToHex(envelopeText());

  beforeAll(async () => {
    anvil = await startAnvil();
    gatewayPort = await freePort();

    const account = privateKeyToAccount(DEPLOYER_KEY);
    const wallet = createWalletClient({ account, chain: foundry, transport: http(anvil.url) });
    publicClient = createPublicClient({ chain: foundry, transport: http(anvil.url) }) as PublicClient;

    const hash = await wallet.deployContract({
      abi,
      bytecode: artifact?.bytecode.object ?? '0x',
      args: [
        account.address,
        [`http://127.0.0.1:${gatewayPort}/v1/{sender}/{data}.json`],
        [gatewaySigner.address],
      ],
    });
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    if (!receipt.contractAddress) throw new Error('ZegelResolver deployment produced no address');
    resolver = receipt.contractAddress;

    config = makeConfig({
      resolvers: [resolver],
      // Real time, because the resolver compares `expires` against block.timestamp.
      now: () => Math.floor(Date.now() / 1000),
    });
    await seedEnvelope(config);
    server = serve({ fetch: createGatewayApp(config).fetch, port: gatewayPort });
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await anvil.stop();
  });

  it('answers data() end to end, through viem CCIP-Read', async () => {
    const result = await publicClient.readContract({
      address: resolver,
      abi,
      functionName: 'data',
      args: [ALICE_NODE, ENVELOPE_SCHEMA],
    });

    expect(result).toBe(envelope);
  });

  it('answers resolve() end to end, with the extra layer of ABI wrapping', async () => {
    const result = (await publicClient.readContract({
      address: resolver,
      abi,
      functionName: 'resolve',
      args: [dnsEncode(ALICE), dataCallData(ALICE_NODE)],
    })) as Hex;

    // resolve() returns the ABI-encoded return of the inner data() call.
    expect(decodeAbiParameters([{ type: 'bytes' }], result)[0]).toBe(envelope);
  });

  it('fails the lookup rather than resolving to nothing when no envelope is published', async () => {
    await expect(
      publicClient.readContract({
        address: resolver,
        abi,
        functionName: 'resolve',
        args: [dnsEncode(BOB), dataCallData(BOB_NODE)],
      }),
    ).rejects.toThrow();
  });

  it('is rejected on chain when a valid response is lifted onto another name', async () => {
    const response = await fetchResponse(dataCallData(ALICE_NODE));

    // The signature is genuine. It is simply not a signature over Bob's query.
    await expect(
      publicClient.readContract({
        address: resolver,
        abi,
        functionName: 'resolveWithProof',
        args: [response, extraData(dataCallData(BOB_NODE), resolver)],
      }),
    ).rejects.toThrow(/UnauthorizedSigner/);
  });

  it('is rejected on chain when extraData names the UniversalResolver', async () => {
    const response = await fetchResponse(dataCallData(ALICE_NODE));

    await expect(
      publicClient.readContract({
        address: resolver,
        abi,
        functionName: 'resolveWithProof',
        args: [response, extraData(dataCallData(ALICE_NODE), UNIVERSAL_RESOLVER)],
      }),
    ).rejects.toThrow(/SenderMismatch/);
  });

  it('is rejected on chain once the response has expired', async () => {
    const callData = dataCallData(ALICE_NODE);
    // Expiry has to be measured against the chain's clock, not the host's. anvil's
    // block.timestamp only advances when a block is mined, so a chain sitting a second
    // or two behind wall time does not consider a host-relative "one second ago"
    // expired — and the assertion fails for a reason that has nothing to do with the
    // contract. Read the block and go back from there.
    const { timestamp } = await publicClient.getBlock({ blockTag: 'latest' });
    const expires = timestamp - 60n;
    const signature = await gatewaySigner.signResponse(resolver, expires, callData, envelope);

    await expect(
      publicClient.readContract({
        address: resolver,
        abi,
        functionName: 'resolveWithProof',
        args: [encodeResponse(envelope, expires, signature), extraData(callData, resolver)],
      }),
    ).rejects.toThrow(/SignatureExpired/);
  });

  it('is rejected on chain after the owner revokes the signer', async () => {
    const account = privateKeyToAccount(DEPLOYER_KEY);
    const wallet = createWalletClient({ account, chain: foundry, transport: http(anvil.url) });

    const response = await fetchResponse(dataCallData(ALICE_NODE));
    const hash = await wallet.writeContract({
      address: resolver,
      abi,
      functionName: 'setSigner',
      args: [gatewaySigner.address, false],
    });
    await publicClient.waitForTransactionReceipt({ hash });

    try {
      await expect(
        publicClient.readContract({
          address: resolver,
          abi,
          functionName: 'resolveWithProof',
          args: [response, extraData(dataCallData(ALICE_NODE), resolver)],
        }),
      ).rejects.toThrow(/UnauthorizedSigner/);
    } finally {
      const restore = await wallet.writeContract({
        address: resolver,
        abi,
        functionName: 'setSigner',
        args: [gatewaySigner.address, true],
      });
      await publicClient.waitForTransactionReceipt({ hash: restore });
    }
  });

  describe('the on-chain health probe', () => {
    it('confirms the deployed resolver allowlists this signer', async () => {
      const report = await buildHealthReport({ ...config, client: publicClient });
      const check = report.checks.find((entry) => entry.name === 'resolver-onchain');

      expect(check?.status).toBe('ok');
      expect(check?.detail).toContain(gatewaySigner.address);
    });

    it('degrades, and names the fix, when the signer is not allowlisted', async () => {
      const stranger = makeConfig({
        resolvers: [resolver],
        signer: { ...gatewaySigner, address: '0x000000000000000000000000000000000000dEaD' },
      });
      const report = await buildHealthReport({ ...stranger, client: publicClient });
      const check = report.checks.find((entry) => entry.name === 'resolver-onchain');

      expect(check?.status).toBe('degraded');
      expect(check?.detail).toContain('setSigner(');
    });
  });

  async function fetchResponse(callData: Hex): Promise<Hex> {
    const response = await fetch(`http://127.0.0.1:${gatewayPort}/v1/${resolver}/${callData}.json`);
    if (!response.ok) throw new Error(`gateway returned ${response.status}: ${await response.text()}`);
    return ((await response.json()) as { data: Hex }).data;
  }
});

function extraData(callData: Hex, sender: Address): Hex {
  return encodeAbiParameters([{ type: 'bytes' }, { type: 'address' }], [callData, sender]);
}

describe.skipIf(runnable)('contract cross-check', () => {
  it('was skipped', () => {
    // Recorded rather than silently absent: a suite that vanishes when a tool is
    // missing is a suite nobody notices stopped running.
    expect(runnable).toBe(false);
    console.warn(
      artifact === null
        ? 'skipped: contracts/out/ZegelResolver.sol/ZegelResolver.json is missing — run `forge build` in contracts/'
        : 'skipped: anvil is not on PATH',
    );
  });
});
