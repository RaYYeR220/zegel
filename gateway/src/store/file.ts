import { constants } from 'node:fs';
import { access, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

import type { Address, Hex } from 'viem';

import { parseEnvelope } from '../envelope.ts';
import { unavailable } from '../errors.ts';

import type { EnvelopeRecord, EnvelopeStore, StoreProbe } from './types.ts';

const STORE_SCHEMA = 'zegel.gateway.store.v1';

interface PersistedRecord {
  name: string | null;
  /** The canonical JSON text of the envelope, verbatim. */
  envelope: string;
  publishedAt: string;
  publisher: Address;
  nonce: string;
}

interface PersistedFile {
  schema: typeof STORE_SCHEMA;
  records: Record<string, PersistedRecord>;
  /** Survives record replacement, so an old signed publish can never be replayed. */
  nonces: Record<string, string>;
}

/**
 * A single JSON file on disk.
 *
 * This is the demo backend, and the reason there is no database in the run
 * instructions. Writes go to a temporary file and are renamed into place, so a
 * process killed mid-publish leaves the previous file intact rather than a
 * half-written one.
 */
export class FileEnvelopeStore implements EnvelopeStore {
  readonly kind = 'file';
  readonly description: string;

  readonly #path: string;
  #loaded: Promise<void> | undefined;
  #writes: Promise<unknown> = Promise.resolve();

  readonly #records = new Map<string, EnvelopeRecord>();
  readonly #nonces = new Map<string, bigint>();

  constructor(path: string) {
    this.#path = resolve(path);
    this.description = `JSON file at ${this.#path}`;
  }

  get path(): string {
    return this.#path;
  }

  async get(node: Hex): Promise<EnvelopeRecord | undefined> {
    await this.#load();
    return this.#records.get(key(node));
  }

  async list(): Promise<readonly EnvelopeRecord[]> {
    await this.#load();
    return [...this.#records.values()];
  }

  async lastNonce(node: Hex): Promise<bigint> {
    await this.#load();
    return this.#nonces.get(key(node)) ?? 0n;
  }

  async put(record: EnvelopeRecord): Promise<void> {
    await this.#load();
    const k = key(record.node);
    this.#records.set(k, record);
    if (record.nonce > (this.#nonces.get(k) ?? 0n)) this.#nonces.set(k, record.nonce);

    // Serialise writes: two concurrent publishes renaming over each other would
    // otherwise leave whichever finished second as the whole file.
    const flush = this.#writes.then(() => this.#flush());
    this.#writes = flush.catch(() => undefined);
    await flush;
  }

  async probe(): Promise<StoreProbe> {
    const started = Date.now();
    try {
      await this.#load();
      await mkdir(dirname(this.#path), { recursive: true });
      await access(dirname(this.#path), constants.W_OK);
      return {
        ok: true,
        detail: this.description,
        records: this.#records.size,
        latencyMs: Date.now() - started,
      };
    } catch (error) {
      return {
        ok: false,
        detail: `${this.description}: ${describe(error)}`,
        records: this.#records.size,
        latencyMs: Date.now() - started,
      };
    }
  }

  #load(): Promise<void> {
    this.#loaded ??= this.#readFile();
    return this.#loaded;
  }

  async #readFile(): Promise<void> {
    let text: string;
    try {
      text = await readFile(this.#path, 'utf8');
    } catch (error) {
      // A missing file is an empty store, which is the normal first run. Anything
      // else is a real failure and must not be papered over as "no envelopes".
      if (isNotFound(error)) return;
      throw unavailable(`cannot read the envelope store at ${this.#path}: ${describe(error)}`, {
        cause: error,
      });
    }

    let parsed: PersistedFile;
    try {
      parsed = JSON.parse(text) as PersistedFile;
    } catch (error) {
      throw unavailable(`the envelope store at ${this.#path} is not valid JSON`, { cause: error });
    }
    if (parsed.schema !== STORE_SCHEMA) {
      throw unavailable(
        `the envelope store at ${this.#path} has schema ${String(parsed.schema)}, expected ${STORE_SCHEMA}`,
      );
    }

    for (const [node, held] of Object.entries(parsed.records ?? {})) {
      this.#records.set(node, {
        node: node as Hex,
        name: held.name,
        envelope: parseEnvelope(held.envelope),
        publishedAt: held.publishedAt,
        publisher: held.publisher,
        nonce: BigInt(held.nonce),
      });
    }
    for (const [node, nonce] of Object.entries(parsed.nonces ?? {})) {
      this.#nonces.set(node, BigInt(nonce));
    }
  }

  async #flush(): Promise<void> {
    const file: PersistedFile = { schema: STORE_SCHEMA, records: {}, nonces: {} };
    for (const [node, record] of this.#records) {
      file.records[node] = {
        name: record.name,
        envelope: record.envelope.text,
        publishedAt: record.publishedAt,
        publisher: record.publisher,
        nonce: record.nonce.toString(),
      };
    }
    for (const [node, nonce] of this.#nonces) file.nonces[node] = nonce.toString();

    await mkdir(dirname(this.#path), { recursive: true });
    const temporary = `${this.#path}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(file, null, 2)}\n`, 'utf8');
    await rename(temporary, this.#path);
  }
}

function key(node: Hex): string {
  return node.toLowerCase();
}

function isNotFound(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: string }).code === 'ENOENT';
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
