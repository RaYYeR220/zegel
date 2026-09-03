import { describe, expect, it } from 'vitest';

import { SealClient } from '../src/client.js';
import { encodeEnvelope } from '../src/envelope.js';
import {
  EnvelopeError,
  GranteeManagementUnavailableError,
  PublisherUnknownError,
  SealError,
} from '../src/errors.js';
import { memoryKeeper } from '../src/keeper.js';
import { coordinatesOf, toSealedTier, type SealReceipt } from '../src/receipt.js';
import {
  FakeServerError,
  FakeSwarm,
  OTHER_KEY,
  PUBLISHER_KEY,
  VERIFIER_KEY,
  fakeBackend,
  gatewayCaps,
  nodeCaps,
} from './fake-swarm.js';

const REFERENCE_ID = '0x9f2c00112233445566778899aabbccddeeff00112233445566778899aabbccdd';
const CLAIMS = { schema: 'zegel.claims.v1', claims: [{ id: 'realized-pnl-usd-90d', passed: true }] };

/** A queue with no real waiting: the floor itself is covered in queue.test.ts. */
const instantQueue = { minIntervalMs: 0 };

function nodeClient(swarm = new FakeSwarm(), options: { warnings?: string[] } = {}) {
  const keep = memoryKeeper();
  const client = new SealClient(fakeBackend(swarm, nodeCaps()), {
    keep,
    queue: instantQueue,
    ...(options.warnings ? { onWarning: (m: string) => options.warnings?.push(m) } : {}),
  });
  return { client, keep, swarm };
}

describe('seal', () => {
  it('returns the three ACT coordinates and persists them before resolving', async () => {
    const { client, keep } = nodeClient();

    const receipt = await client.seal(CLAIMS, [VERIFIER_KEY], { referenceId: REFERENCE_ID, tier: 1 });

    expect(receipt.swarmRef).toMatch(/^[0-9a-f]{64}$/);
    expect(receipt.actHistoryAddress).toMatch(/^[0-9a-f]{64}$/);
    expect(receipt.actPublisher).toBe(PUBLISHER_KEY);
    expect(keep.receipts).toEqual([receipt]);
  });

  it('fails the seal when the receipt could not be persisted', async () => {
    const client = new SealClient(fakeBackend(new FakeSwarm(), nodeCaps()), {
      keep: () => {
        throw new Error('disk full');
      },
      queue: instantQueue,
    });

    await expect(client.seal(CLAIMS, [], { referenceId: REFERENCE_ID })).rejects.toThrowError(/disk full/);
  });

  it('creates a grantee list before uploading, so the content is sealed to it', async () => {
    const { client, swarm } = nodeClient();

    const receipt = await client.seal(CLAIMS, [VERIFIER_KEY, OTHER_KEY], { referenceId: REFERENCE_ID });

    expect(swarm.patches).toHaveLength(1);
    expect(swarm.patches[0]?.add).toEqual([VERIFIER_KEY, OTHER_KEY]);
    expect(receipt.granteeListRef).toBeDefined();
    expect(receipt.grantees.applied).toEqual([VERIFIER_KEY, OTHER_KEY]);
    expect(receipt.grantees.deferred).toEqual([]);
  });

  it('refuses to report an upload as sealed when no ACT history came back', async () => {
    const swarm = new FakeSwarm({ omitHistoryAddress: true });
    const { client } = nodeClient(swarm);

    await expect(client.seal(CLAIMS, [], { referenceId: REFERENCE_ID })).rejects.toThrowError(SealError);
    await expect(client.seal(CLAIMS, [], { referenceId: REFERENCE_ID })).rejects.toThrowError(
      /not access-controlled/,
    );
  });

  it('records the digest the public commitment is built from', async () => {
    const { client } = nodeClient();
    const receipt = await client.seal(CLAIMS, [], { referenceId: REFERENCE_ID, sealedAt: '2026-09-03T20:00:00.000Z' });
    expect(receipt.digest).toMatch(/^0x[0-9a-f]{64}$/);
    expect(receipt.sealedAt).toBe('2026-09-03T20:00:00.000Z');
  });
});

describe('degrading to the gateway', () => {
  it('refuses by default to seal with grantees a gateway cannot grant', async () => {
    const client = new SealClient(fakeBackend(new FakeSwarm(), gatewayCaps()), {
      keep: memoryKeeper(),
      queue: instantQueue,
    });

    await expect(client.seal(CLAIMS, [VERIFIER_KEY], { referenceId: REFERENCE_ID })).rejects.toThrowError(
      GranteeManagementUnavailableError,
    );
  });

  it('defers grantees only when explicitly asked, and says so out loud', async () => {
    const warnings: string[] = [];
    const client = new SealClient(fakeBackend(new FakeSwarm(), gatewayCaps()), {
      keep: memoryKeeper(),
      queue: instantQueue,
      onWarning: (message) => warnings.push(message),
    });

    const receipt = await client.seal(CLAIMS, [VERIFIER_KEY], {
      referenceId: REFERENCE_ID,
      whenGranteesUnsupported: 'defer',
    });

    expect(receipt.grantees.applied).toEqual([]);
    expect(receipt.grantees.deferred).toEqual([VERIFIER_KEY]);
    expect(receipt.grantees.reason).toMatch(/NOT granted/);
    expect(warnings.join(' ')).toMatch(/NOT granted/);
  });

  it('seals without a publisher key but warns that the object cannot be read back', async () => {
    const warnings: string[] = [];
    const client = new SealClient(fakeBackend(new FakeSwarm(), gatewayCaps(), null), {
      keep: memoryKeeper(),
      queue: instantQueue,
      onWarning: (message) => warnings.push(message),
    });

    const receipt = await client.seal(CLAIMS, [], { referenceId: REFERENCE_ID });

    expect(receipt.actPublisher).toBeNull();
    expect(warnings.join(' ')).toMatch(/does not expose its public key/);
    expect(() => toSealedTier(receipt)).toThrowError(PublisherUnknownError);
    expect(() => coordinatesOf(receipt)).toThrowError(PublisherUnknownError);
  });

  it('refuses grant and revoke rather than pretending they worked', async () => {
    const client = new SealClient(fakeBackend(new FakeSwarm(), gatewayCaps()), {
      keep: memoryKeeper(),
      queue: instantQueue,
    });
    const receipt = { granteeListRef: 'a'.repeat(64) } as unknown as SealReceipt;

    await expect(client.grant(receipt, [VERIFIER_KEY])).rejects.toThrowError(
      GranteeManagementUnavailableError,
    );
    await expect(client.revoke(receipt, [VERIFIER_KEY])).rejects.toThrowError(
      GranteeManagementUnavailableError,
    );
    expect(client.caps.canManageGrantees).toBe(false);
  });
});

describe('unseal', () => {
  it('returns the payload to a reader holding the coordinates', async () => {
    const { client } = nodeClient();
    const receipt = await client.seal(CLAIMS, [], { referenceId: REFERENCE_ID });

    const result = await client.unseal<typeof CLAIMS>(coordinatesOf(receipt));

    expect(result.granted).toBe(true);
    if (result.granted) expect(result.payload).toEqual(CLAIMS);
  });

  it('returns a typed NotGranted, never a thrown error, when Swarm answers 404', async () => {
    const { client } = nodeClient();
    const receipt = await client.seal(CLAIMS, [], { referenceId: REFERENCE_ID });

    const wrongHistory = { ...coordinatesOf(receipt), actHistoryAddress: 'f'.repeat(64) as never };
    const result = await client.unseal(wrongHistory);

    expect(result).toEqual({ granted: false, reason: 'not-granted-or-absent' });
  });

  it('cannot tell a revoked read apart from content that never existed', async () => {
    const { client } = nodeClient();
    const receipt = await client.seal(CLAIMS, [], { referenceId: REFERENCE_ID });

    const revoked = await client.unseal({ ...coordinatesOf(receipt), actPublisher: OTHER_KEY });
    const absent = await client.unseal({ ...coordinatesOf(receipt), swarmRef: 'b'.repeat(64) as never });

    expect(revoked).toEqual(absent);
  });

  it('throws on a fault rather than mislabelling it as a missing grant', async () => {
    const swarm = new FakeSwarm({ downloadError: new FakeServerError() });
    const { client } = nodeClient(swarm);
    const sealed = await nodeClient().client.seal(CLAIMS, [], { referenceId: REFERENCE_ID });

    await expect(client.unseal(coordinatesOf(sealed))).rejects.toThrowError(FakeServerError);
  });

  it('throws when the decrypted bytes are not a valid envelope', async () => {
    const { client, swarm } = nodeClient();
    const receipt = await client.seal(CLAIMS, [], { referenceId: REFERENCE_ID });

    swarm.overwrite(
      receipt.swarmRef,
      encodeEnvelope({ tier: 1, referenceId: REFERENCE_ID, payload: { tampered: true } }),
    );
    const bad = swarm.objects.get(receipt.swarmRef);
    if (bad) bad.body = new TextEncoder().encode(JSON.stringify({ schema: 'zegel.seal.v1', tier: 1 }));

    await expect(client.unseal(coordinatesOf(receipt))).rejects.toThrowError(EnvelopeError);
  });
});

describe('grant and revoke', () => {
  it('adds a key and reports the new history readers must use', async () => {
    const { client } = nodeClient();
    const receipt = await client.seal(CLAIMS, [VERIFIER_KEY], { referenceId: REFERENCE_ID });

    const result = await client.grant(receipt, [OTHER_KEY]);

    expect(result.added).toEqual([OTHER_KEY]);
    expect(result.revoked).toEqual([]);
    expect(result.rotationRequired).toBe(false);
    expect(result.actHistoryAddress).not.toBe(receipt.actHistoryAddress);
  });

  it('flags that a revoke only takes effect for content re-sealed afterwards', async () => {
    const { client } = nodeClient();
    const receipt = await client.seal(CLAIMS, [VERIFIER_KEY], { referenceId: REFERENCE_ID });

    const result = await client.revoke(receipt, [VERIFIER_KEY]);

    expect(result.revoked).toEqual([VERIFIER_KEY]);
    expect(result.rotationRequired).toBe(true);
  });

  it('serialises patches through the rate-floored queue', async () => {
    const { client, swarm } = nodeClient();
    const receipt = await client.seal(CLAIMS, [VERIFIER_KEY], { referenceId: REFERENCE_ID });

    const inFlight = [
      client.grant(receipt, [OTHER_KEY]),
      client.revoke(receipt, [VERIFIER_KEY]),
      client.grant(receipt, [VERIFIER_KEY]),
    ];
    expect(client.pendingPatches).toBe(3);

    await Promise.all(inFlight);
    expect(client.pendingPatches).toBe(0);
    // One create at seal time plus three patches, in the order they were requested.
    expect(swarm.patches).toHaveLength(4);
    expect(swarm.patches.slice(1).map((patch) => [patch.add, patch.revoke])).toEqual([
      [[OTHER_KEY], []],
      [[], [VERIFIER_KEY]],
      [[VERIFIER_KEY], []],
    ]);
  });

  it('refuses to patch a receipt that never had a grantee list', async () => {
    const { client } = nodeClient();
    const receipt = await client.seal(CLAIMS, [], { referenceId: REFERENCE_ID });

    await expect(client.grant(receipt, [VERIFIER_KEY])).rejects.toThrowError(/no grantee list/);
  });

  it('combines an add and a remove into one rate-floor slot', async () => {
    const { client, swarm } = nodeClient();
    const receipt = await client.seal(CLAIMS, [VERIFIER_KEY], { referenceId: REFERENCE_ID });

    await client.patchGrantees(receipt, { add: [OTHER_KEY], revoke: [VERIFIER_KEY] });

    expect(swarm.patches).toHaveLength(2);
    expect(swarm.patches[1]).toMatchObject({ add: [OTHER_KEY], revoke: [VERIFIER_KEY] });
  });

  it('reports queue depth so a UI can show pending grants', async () => {
    const { client } = nodeClient();
    const receipt = await client.seal(CLAIMS, [VERIFIER_KEY], { referenceId: REFERENCE_ID });

    const depths: number[] = [];
    const unsubscribe = client.onQueueDepthChange((depth) => depths.push(depth));

    await Promise.all([client.grant(receipt, [OTHER_KEY]), client.revoke(receipt, [OTHER_KEY])]);
    unsubscribe();

    expect(Math.max(...depths)).toBe(2);
    expect(depths.at(-1)).toBe(0);
  });

  it('lists the grantees the publisher set', async () => {
    const { client } = nodeClient();
    const receipt = await client.seal(CLAIMS, [VERIFIER_KEY], { referenceId: REFERENCE_ID });

    await expect(client.listGrantees(receipt)).resolves.toEqual([VERIFIER_KEY]);
  });
});

describe('reseal', () => {
  it('writes new bytes under the same reference identity and keeps the receipt', async () => {
    const { client, keep } = nodeClient();
    const receipt = await client.seal(CLAIMS, [VERIFIER_KEY], { referenceId: REFERENCE_ID });

    const updated = await client.reseal(receipt, { ...CLAIMS, revision: 2 });

    expect(updated.referenceId).toBe(receipt.referenceId);
    expect(updated.swarmRef).not.toBe(receipt.swarmRef);
    expect(updated.digest).not.toBe(receipt.digest);
    expect(keep.receipts).toHaveLength(2);
  });
});
