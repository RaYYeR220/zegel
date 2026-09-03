import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { SealError } from '../src/errors.js';
import { allKeepers, fileKeeper, memoryKeeper, readKeptReceipts } from '../src/keeper.js';
import { coordinatesFromTier, coordinatesOf, isReadable, toSealedTier, type SealReceipt } from '../src/receipt.js';
import { historyAddress, isHistoryAddress, isSwarmReference, swarmReference } from '../src/refs.js';
import { PUBLISHER_KEY } from './fake-swarm.js';

const REF = 'a'.repeat(64);
const HISTORY = 'b'.repeat(64);

const RECEIPT: SealReceipt = {
  tier: 2,
  referenceId: '0x' + 'c'.repeat(64),
  swarmRef: swarmReference(REF),
  actHistoryAddress: historyAddress(HISTORY),
  actPublisher: PUBLISHER_KEY,
  digest: '0x' + 'd'.repeat(64),
  sealedAt: '2026-09-03T20:00:00.000Z',
  backend: 'node',
  backendUrl: 'http://localhost:1633',
  batchId: '0'.repeat(64),
  grantees: { applied: [], deferred: [] },
  bytes: 512,
};

const temporary: string[] = [];

afterAll(async () => {
  await Promise.all(temporary.map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('reference types', () => {
  it('accepts both plain and encrypted reference lengths', () => {
    expect(swarmReference(REF)).toBe(REF);
    expect(swarmReference('c'.repeat(128))).toHaveLength(128);
    expect(isSwarmReference(REF)).toBe(true);
  });

  it('rejects a truncated history address, which would 404 exactly like a revocation', () => {
    expect(() => historyAddress(HISTORY.slice(0, 63))).toThrowError(SealError);
    expect(isHistoryAddress(HISTORY.slice(0, 63))).toBe(false);
    // 128 chars is a valid reference but never a valid history address.
    expect(() => historyAddress('c'.repeat(128))).toThrowError(/64 hex chars/);
  });

  it('normalises a 0x prefix and casing', () => {
    expect(swarmReference(`0x${REF.toUpperCase()}`)).toBe(REF);
    expect(historyAddress(`0X${HISTORY.toUpperCase()}`)).toBe(HISTORY);
  });
});

describe('receipts', () => {
  it('narrows to the public tier record the envelope carries', () => {
    expect(toSealedTier(RECEIPT)).toEqual({
      tier: 2,
      swarmRef: REF,
      actHistoryAddress: HISTORY,
      actPublisher: PUBLISHER_KEY,
    });
    expect(isReadable(RECEIPT)).toBe(true);
  });

  it('round-trips through the public tier record', () => {
    expect(coordinatesFromTier(toSealedTier(RECEIPT))).toEqual(coordinatesOf(RECEIPT));
  });

  it('validates a tier record read back from elsewhere', () => {
    expect(() =>
      coordinatesFromTier({ ...toSealedTier(RECEIPT), actHistoryAddress: 'nope' }),
    ).toThrowError(/history address/);
  });
});

describe('receipt keepers', () => {
  it('collects receipts in memory', () => {
    const keeper = memoryKeeper();
    keeper(RECEIPT);
    expect(keeper.receipts).toEqual([RECEIPT]);
  });

  it('appends to a file so an earlier history address survives a later failure', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'zegel-seal-'));
    temporary.push(dir);
    const path = join(dir, 'nested', 'receipts.jsonl');

    const keeper = fileKeeper(path);
    await keeper(RECEIPT);
    await keeper({ ...RECEIPT, swarmRef: swarmReference('e'.repeat(64)) });

    const kept = await readKeptReceipts(path);
    expect(kept).toHaveLength(2);
    expect(kept[0]?.actHistoryAddress).toBe(HISTORY);
    expect(kept[1]?.swarmRef).toBe('e'.repeat(64));
  });

  it('returns nothing rather than throwing for a log that does not exist yet', async () => {
    await expect(readKeptReceipts(join(tmpdir(), 'zegel-seal-absent', 'none.jsonl'))).resolves.toEqual([]);
  });

  it('fans out to every sink and fails if any of them does', async () => {
    const memory = memoryKeeper();
    const failing = () => {
      throw new Error('sink down');
    };

    await expect(allKeepers(memory, failing)(RECEIPT)).rejects.toThrowError(/sink down/);
    expect(memory.receipts).toHaveLength(1);
  });
});
