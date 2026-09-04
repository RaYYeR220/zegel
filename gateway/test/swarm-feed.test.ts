import { hexToBytes, stringToHex, type Address, type Hex } from 'viem';
import { describe, expect, it } from 'vitest';

import { createGatewayApp } from '../src/app.ts';
import { buildHealthReport } from '../src/health.ts';
import {
  DEFAULT_BEE_URL,
  SwarmFeedEnvelopeStore,
  feedTopic,
} from '../src/store/swarm-feed.ts';

import {
  ALICE_NODE,
  BOB_NODE,
  dataCallData,
  envelopeText,
  FIXED_NOW,
  makeConfig,
  RESOLVER,
} from './helpers.ts';

const OWNER: Address = '0x1d755b42e1f483CD6812f76CA63Ae903a18074b8';
const KEY = 'zegel.envelope.v1';
const REFERENCE = '0e4a46e9f5eb7e8f590696e06907b5a2d4651903c4e356f7407e2bd742a48cdd';

type Body = string | Uint8Array | number;

interface BeeBehaviour {
  /** Body for `GET /feeds/{owner}/{topic}`, or a status to answer with. */
  feed?: Body | undefined;
  bytes?: Body | undefined;
  health?: number | undefined;
  feedIndex?: string | undefined;
  throws?: string | undefined;
}

interface FakeBee {
  fetch: typeof globalThis.fetch;
  calls: string[];
  behaviour: BeeBehaviour;
}

function fakeBee(behaviour: BeeBehaviour): FakeBee {
  const calls: string[] = [];

  const fetchImpl = (async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);
    if (fake.behaviour.throws) throw new Error(fake.behaviour.throws);

    if (url.endsWith('/health')) {
      return new Response('OK', { status: fake.behaviour.health ?? 200 });
    }
    if (url.includes('/feeds/')) {
      const feed = fake.behaviour.feed;
      if (typeof feed === 'number') return new Response(null, { status: feed });
      return new Response((feed ?? null) as BodyInit | null, {
        status: 200,
        headers: { 'swarm-feed-index': fake.behaviour.feedIndex ?? '0000000000000000' },
      });
    }
    if (url.includes('/bytes/')) {
      const bytes = fake.behaviour.bytes;
      if (typeof bytes === 'number') return new Response(null, { status: bytes });
      return new Response((bytes ?? null) as BodyInit | null, { status: 200 });
    }
    return new Response(null, { status: 404 });
  }) as typeof globalThis.fetch;

  const fake: FakeBee = { fetch: fetchImpl, calls, behaviour };
  return fake;
}

function store(bee: FakeBee, overrides: { now?: () => number; cacheTtlSeconds?: number } = {}) {
  return new SwarmFeedEnvelopeStore({
    beeUrl: 'https://bee.test',
    owner: OWNER,
    dataKey: KEY,
    fetch: bee.fetch,
    now: overrides.now ?? (() => FIXED_NOW),
    cacheTtlSeconds: overrides.cacheTtlSeconds ?? 15,
  });
}

/** 8-byte big-endian timestamp followed by a 32-byte reference — a reference-type feed slot. */
function timestampedReference(reference: string): Uint8Array {
  const payload = new Uint8Array(40);
  payload.set(hexToBytes(`0x${reference}`), 8);
  return payload;
}

describe('feed topic derivation', () => {
  /**
   * Pinned, because a judge has to be able to recompute where an envelope lives from
   * the name alone — and because changing it silently orphans every published feed.
   */
  it('matches the documented worked example for alice.eth', () => {
    expect(ALICE_NODE).toBe('0x787192fc5378cc32aa956ddfdedbf26b24e8d78e40109add0eea2c1a012c3dec');
    expect(feedTopic(ALICE_NODE, KEY)).toBe(
      '0xe2bdd8e5a9b5a5cf463ffd8e2e12d8c24adfaaefe5b2bb6750fc6a773f3ca4b5',
    );
  });

  it('separates record keys, so a second key cannot collide with the envelope', () => {
    expect(feedTopic(ALICE_NODE, KEY)).not.toBe(feedTopic(ALICE_NODE, 'zegel.something.else'));
  });

  it('separates names', () => {
    expect(feedTopic(ALICE_NODE, KEY)).not.toBe(feedTopic(BOB_NODE, KEY));
  });

  it('defaults to the public gateway, which serves feed reads with no credentials', () => {
    expect(DEFAULT_BEE_URL).toBe('https://api.gateway.ethswarm.org');
  });
});

describe('SwarmFeedEnvelopeStore', () => {
  it('reads an envelope Bee resolved for it', async () => {
    const bee = fakeBee({ feed: envelopeText() });
    const record = await store(bee).get(ALICE_NODE);

    expect(record?.envelope.text).toBe(envelopeText());
    expect(record?.publisher).toBe(OWNER);
    expect(bee.calls[0]).toBe(
      `https://bee.test/feeds/${OWNER.slice(2).toLowerCase()}/${feedTopic(ALICE_NODE, KEY).slice(2)}`,
    );
  });

  /** A feed slot is 4 KB, so the envelope lives behind a reference. Follow it. */
  it('follows a timestamped reference to the content', async () => {
    const bee = fakeBee({ feed: timestampedReference(REFERENCE), bytes: envelopeText() });
    const record = await store(bee).get(ALICE_NODE);

    expect(record?.envelope.text).toBe(envelopeText());
    expect(bee.calls[1]).toBe(`https://bee.test/bytes/${REFERENCE}`);
  });

  it('follows a bare 32-byte reference', async () => {
    const bee = fakeBee({ feed: hexToBytes(`0x${REFERENCE}`), bytes: envelopeText() });
    const record = await store(bee).get(ALICE_NODE);

    expect(record?.envelope.text).toBe(envelopeText());
    expect(bee.calls[1]).toBe(`https://bee.test/bytes/${REFERENCE}`);
  });

  it('follows a reference written as hex text', async () => {
    const bee = fakeBee({ feed: `0x${REFERENCE}`, bytes: envelopeText() });
    const record = await store(bee).get(ALICE_NODE);

    expect(record?.envelope.text).toBe(envelopeText());
  });

  it('reads the feed index as the nonce, since the feed is its own version counter', async () => {
    const bee = fakeBee({ feed: envelopeText(), feedIndex: '0000000000000007' });
    expect((await store(bee).get(ALICE_NODE))?.nonce).toBe(7n);
    expect(await store(bee).lastNonce(ALICE_NODE)).toBe(7n);
  });

  it('reports an unpublished name as absent, with no failure recorded', async () => {
    const bee = fakeBee({ feed: 404 });
    const subject = store(bee);

    expect(await subject.get(ALICE_NODE)).toBeUndefined();
    expect((await subject.probe()).ok).toBe(true);
  });

  /**
   * The collapse the design accepts: an unreachable feed answers like an unpublished
   * name, because the alternative is signing an answer we could not verify. It is not
   * silent — the probe says what happened.
   */
  it('reports an unreachable feed as absent, and degrades the probe with the reason', async () => {
    const bee = fakeBee({ throws: 'ECONNREFUSED bee.test:443' });
    const subject = store(bee);

    expect(await subject.get(ALICE_NODE)).toBeUndefined();

    bee.behaviour.throws = undefined;
    const probe = await subject.probe();
    expect(probe.ok).toBe(false);
    expect(probe.detail).toContain('ECONNREFUSED');
  });

  it('treats a 500 from the feed as a failure, not as an unpublished name', async () => {
    const bee = fakeBee({ feed: 500 });
    const subject = store(bee);

    expect(await subject.get(ALICE_NODE)).toBeUndefined();
    expect((await subject.probe()).detail).toContain('500');
  });

  it('treats content that is not an envelope as a failure, not as an unpublished name', async () => {
    const bee = fakeBee({ feed: '{"schema":"something.else"}' });
    const subject = store(bee);

    expect(await subject.get(ALICE_NODE)).toBeUndefined();
    expect((await subject.probe()).detail).toContain('not a Zegel envelope');
  });

  it('fails rather than serving the pointer itself when the content is gone', async () => {
    const bee = fakeBee({ feed: timestampedReference(REFERENCE), bytes: 404 });
    const subject = store(bee);

    expect(await subject.get(ALICE_NODE)).toBeUndefined();
    expect((await subject.probe()).detail).toContain(REFERENCE);
  });

  it('serves from cache inside the TTL and refetches after it', async () => {
    const clock = { seconds: FIXED_NOW };
    const bee = fakeBee({ feed: envelopeText() });
    const subject = store(bee, { now: () => clock.seconds, cacheTtlSeconds: 15 });

    await subject.get(ALICE_NODE);
    await subject.get(ALICE_NODE);
    expect(bee.calls).toHaveLength(1);

    clock.seconds = FIXED_NOW + 15;
    await subject.get(ALICE_NODE);
    expect(bee.calls).toHaveLength(2);
  });

  /** A cached envelope must never outlive its own expiry, however long the TTL. */
  it('refetches a cached envelope that has passed its own expiresAt', async () => {
    const clock = { seconds: FIXED_NOW };
    const expiresAt = new Date((FIXED_NOW + 10) * 1000).toISOString();
    const bee = fakeBee({ feed: envelopeText({ expiresAt }) });
    const subject = store(bee, { now: () => clock.seconds, cacheTtlSeconds: 3600 });

    await subject.get(ALICE_NODE);
    clock.seconds = FIXED_NOW + 11;
    await subject.get(ALICE_NODE);

    expect(bee.calls).toHaveLength(2);
  });

  it('keeps serving a stale but unexpired envelope while the feed is unreachable', async () => {
    const clock = { seconds: FIXED_NOW };
    const bee = fakeBee({ feed: envelopeText() });
    const subject = store(bee, { now: () => clock.seconds, cacheTtlSeconds: 15 });

    await subject.get(ALICE_NODE);
    bee.behaviour.throws = 'network down';
    clock.seconds = FIXED_NOW + 60;

    const record = await subject.get(ALICE_NODE);
    expect(record?.envelope.text).toBe(envelopeText());
    // Still not pretending everything is fine.
    bee.behaviour.throws = undefined;
    expect((await subject.probe()).ok).toBe(false);
  });

  it('refuses to hold state', async () => {
    const subject = store(fakeBee({}));
    expect(subject.writable).toBe(false);
    await expect(subject.put()).rejects.toThrow(/reads from a Swarm feed and holds no state/);
  });

  it('lists only what it has already been asked for, because a feed cannot be enumerated', async () => {
    const bee = fakeBee({ feed: envelopeText() });
    const subject = store(bee);

    expect(await subject.list()).toHaveLength(0);
    await subject.get(ALICE_NODE);
    expect(await subject.list()).toHaveLength(1);
  });

  it('degrades the probe when Bee answers but is unhealthy', async () => {
    const probe = await store(fakeBee({ health: 503 })).probe();
    expect(probe.ok).toBe(false);
    expect(probe.detail).toContain('503');
  });
});

describe('a gateway backed by a feed', () => {
  const feedConfig = (bee: FakeBee) =>
    makeConfig({
      store: new SwarmFeedEnvelopeStore({
        beeUrl: 'https://bee.test',
        owner: OWNER,
        dataKey: KEY,
        fetch: bee.fetch,
        now: () => FIXED_NOW,
      }),
    });

  it('serves a signed response with nothing of its own stored', async () => {
    const bee = fakeBee({ feed: envelopeText() });
    const response = await createGatewayApp(feedConfig(bee)).request(
      `/v1/${RESOLVER}/${dataCallData(ALICE_NODE)}`,
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as { data: Hex };
    expect(body.data).toContain(stringToHex(envelopeText()).slice(2));
  });

  it('404s when the feed is unreachable, exactly as for an unpublished name', async () => {
    const unreachable = await createGatewayApp(feedConfig(fakeBee({ throws: 'dns failure' }))).request(
      `/v1/${RESOLVER}/${dataCallData(ALICE_NODE)}`,
    );
    const unpublished = await createGatewayApp(feedConfig(fakeBee({ feed: 404 }))).request(
      `/v1/${RESOLVER}/${dataCallData(ALICE_NODE)}`,
    );

    expect(unreachable.status).toBe(404);
    expect(await unreachable.json()).toEqual(await unpublished.json());
  });

  it('refuses a publish up front rather than authenticating one it cannot honour', async () => {
    const response = await createGatewayApp(feedConfig(fakeBee({}))).request('/admin/envelopes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ node: ALICE_NODE }),
    });

    expect(response.status).toBe(501);
    expect(await response.json()).toMatchObject({
      message: expect.stringContaining('read-only'),
    });
  });

  it('surfaces an unreachable feed in /health, and skips the ownership check', async () => {
    const bee = fakeBee({ throws: 'network down' });
    const config = feedConfig(bee);
    await config.store.get(ALICE_NODE);

    const report = await buildHealthReport(config);
    const storeCheck = report.checks.find((check) => check.name === 'store');
    const owners = report.checks.find((check) => check.name === 'name-ownership');

    expect(report.status).toBe('down');
    expect(storeCheck?.detail).toContain('network down');
    expect(owners?.status).toBe('skipped');
  });

  it('degrades rather than going down while it can still answer from cache', async () => {
    const bee = fakeBee({ feed: envelopeText() });
    const config = feedConfig(bee);
    await config.store.get(ALICE_NODE);
    bee.behaviour.throws = 'network down';

    const report = await buildHealthReport(config);
    expect(report.checks.find((check) => check.name === 'store')?.status).toBe('degraded');
    expect(report.status).toBe('degraded');
  });
});
