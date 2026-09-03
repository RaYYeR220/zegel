import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createGatewayApp } from '../src/app.ts';
import { parseEnvelope } from '../src/envelope.ts';
import { FileEnvelopeStore } from '../src/store/file.ts';
import { MemoryEnvelopeStore } from '../src/store/memory.ts';
import type { EnvelopeRecord } from '../src/store/types.ts';

import {
  ALICE_NODE,
  BOB_NODE,
  dataCallData,
  envelopeText,
  makeConfig,
  ownerAccount,
  publishBody,
  RESOLVER,
} from './helpers.ts';

function record(nonce = 1n): EnvelopeRecord {
  return {
    node: ALICE_NODE.toLowerCase() as `0x${string}`,
    name: 'alice.eth',
    envelope: parseEnvelope(envelopeText()),
    publishedAt: '2026-09-04T12:00:00.000Z',
    publisher: ownerAccount.address,
    nonce,
  };
}

describe('MemoryEnvelopeStore', () => {
  it('remembers the highest nonce even after the record is replaced', async () => {
    const store = new MemoryEnvelopeStore();
    await store.put(record(5n));
    await store.put(record(2n));

    expect(await store.lastNonce(ALICE_NODE)).toBe(5n);
  });

  it('is case-insensitive about the node', async () => {
    const store = new MemoryEnvelopeStore();
    await store.put(record());

    expect(await store.get(ALICE_NODE.toUpperCase() as `0x${string}`)).toBeDefined();
    expect(await store.get(BOB_NODE)).toBeUndefined();
  });

  it('says out loud that it loses everything on restart', async () => {
    const probe = await new MemoryEnvelopeStore().probe();
    expect(probe.ok).toBe(true);
    expect(probe.detail).toContain('lost on restart');
  });
});

describe('FileEnvelopeStore', () => {
  let directory: string;
  let path: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'zegel-gateway-'));
    path = join(directory, 'envelopes.json');
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it('treats a missing file as an empty store, not a failure', async () => {
    const store = new FileEnvelopeStore(path);

    expect(await store.get(ALICE_NODE)).toBeUndefined();
    expect((await store.probe()).ok).toBe(true);
  });

  it('survives a restart', async () => {
    await new FileEnvelopeStore(path).put(record(3n));

    const reopened = new FileEnvelopeStore(path);
    const held = await reopened.get(ALICE_NODE);
    expect(held?.envelope.text).toBe(envelopeText());
    expect(held?.nonce).toBe(3n);
    expect(await reopened.lastNonce(ALICE_NODE)).toBe(3n);
  });

  it('stores the envelope as text, byte for byte', async () => {
    await new FileEnvelopeStore(path).put(record());

    const onDisk = JSON.parse(await readFile(path, 'utf8')) as {
      records: Record<string, { envelope: string }>;
    };
    expect(onDisk.records[ALICE_NODE.toLowerCase()]?.envelope).toBe(envelopeText());
  });

  /** A corrupt file must not read as "no envelopes published". */
  it('refuses to start empty when the file is unreadable', async () => {
    await writeFile(path, 'not json at all', 'utf8');
    const store = new FileEnvelopeStore(path);

    await expect(store.get(ALICE_NODE)).rejects.toThrow(/not valid JSON/);
    expect((await store.probe()).ok).toBe(false);
  });

  it('refuses a file written by a different store schema', async () => {
    await writeFile(path, JSON.stringify({ schema: 'other.v9', records: {}, nonces: {} }), 'utf8');

    await expect(new FileEnvelopeStore(path).get(ALICE_NODE)).rejects.toThrow(/schema/);
  });

  it('backs a full publish-then-resolve round trip', async () => {
    const config = makeConfig({ store: new FileEnvelopeStore(path) });
    const app = createGatewayApp(config);

    const published = await app.request('/admin/envelopes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(await publishBody(config)),
    });
    expect(published.status).toBe(201);

    // A second process reading the same file resolves the same name.
    const restarted = createGatewayApp(makeConfig({ store: new FileEnvelopeStore(path) }));
    const resolved = await restarted.request(`/v1/${RESOLVER}/${dataCallData(ALICE_NODE)}`);
    expect(resolved.status).toBe(200);
  });
});
