import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';

import { Bee } from '@ethersphere/bee-js';
import { isHex, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { namehash } from 'viem/ens';

import { ENVELOPE_SCHEMA } from '../../packages/sdk/src/types.ts';
import { parseEnvelope } from '../src/envelope.ts';
import { DEFAULT_BEE_URL, SwarmFeedEnvelopeStore, feedTopic } from '../src/store/swarm-feed.ts';

/**
 * Publishes an envelope by writing the Swarm feed the gateway reads.
 *
 * This runs on the issuer's own Bee node, because writing a feed means signing a
 * single-owner chunk and paying postage — neither of which the gateway does, has, or
 * should. The gateway only ever reads, from any Bee node, which is what lets it be
 * deployed serverless with no state at all.
 *
 * The envelope file is uploaded **verbatim**. Produce it with `canonicalize()` from
 * `@zegel/sdk` so its digest is the one every other module computes.
 */
async function writeFeed(): Promise<void> {
  const { values } = parseArgs({
    options: {
      bee: { type: 'string', default: 'http://127.0.0.1:1633' },
      'read-bee': { type: 'string', default: DEFAULT_BEE_URL },
      batch: { type: 'string' },
      key: { type: 'string' },
      name: { type: 'string' },
      node: { type: 'string' },
      envelope: { type: 'string' },
      'data-key': { type: 'string', default: ENVELOPE_SCHEMA },
      'skip-verify': { type: 'boolean', default: false },
    },
  });

  const key = values.key ?? process.env['ZEGEL_FEED_KEY'];
  if (!key || !isHex(key) || key.length !== 66) {
    fail('pass the feed signing key with --key 0x… or ZEGEL_FEED_KEY (32 bytes, hex)');
  }
  const batch = values.batch ?? process.env['ZEGEL_POSTAGE_BATCH'];
  if (!batch || !/^[0-9a-fA-F]{64}$/u.test(batch)) {
    fail('pass the postage batch with --batch <64 hex> or ZEGEL_POSTAGE_BATCH');
  }
  if (!values.envelope) fail('pass the envelope file with --envelope ./envelope.json');
  if (!values.name && !values.node) fail('pass --name alice.eth or --node 0x…');

  const node: Hex = values.node ? (values.node as Hex) : namehash(values.name as string);
  if (!isHex(node) || node.length !== 66) fail('--node must be 32 bytes of 0x-prefixed hex');

  // Trailing newlines are what an editor adds and a digest notices.
  const text = readFileSync(values.envelope, 'utf8').replace(/\s+$/u, '');
  // Fail here rather than after paying postage for something no client can read.
  const envelope = parseEnvelope(text);

  const owner = privateKeyToAccount(key).address;
  const topic = feedTopic(node.toLowerCase() as Hex, values['data-key']);
  const bee = new Bee(values.bee);

  const uploaded = await bee.data.upload(batch, text);
  const reference = uploaded.reference.toHex();

  // The feed slot holds 4 KB, so it carries the reference and the envelope is
  // ordinary Swarm content behind it.
  const writer = bee.feed.makeWriter(topic.slice(2), key);
  const update = await writer.uploadReference(batch, uploaded.reference);

  console.log(`node        ${node}`);
  console.log(`data key    ${values['data-key']}`);
  console.log(`feed owner  ${owner}`);
  console.log(`feed topic  ${topic}`);
  console.log(`envelope    ${reference}  (${text.length} bytes, digest ${envelope.digest})`);
  console.log(`feed update ${update.reference.toHex()}`);
  console.log(`expires     ${envelope.envelope.expiresAt}`);
  console.log('');
  console.log('set on the gateway:');
  console.log('  ZEGEL_STORE=swarm-feed');
  console.log(`  ZEGEL_FEED_OWNER=${owner}`);
  console.log(`  ZEGEL_BEE_URL=${values['read-bee']}`);

  if (values['skip-verify']) return;

  // Read it back the way the gateway will, through the read endpoint the gateway
  // will use — not through the node that just wrote it.
  const store = new SwarmFeedEnvelopeStore({
    beeUrl: values['read-bee'],
    owner,
    dataKey: values['data-key'],
    cacheTtlSeconds: 0,
  });
  const readBack = await store.get(node);
  if (!readBack) {
    fail(
      `written, but ${values['read-bee']} does not serve the feed yet. Chunks take a moment to ` +
        'propagate; re-run with --skip-verify and check again shortly.',
    );
  }
  if (readBack.envelope.digest !== envelope.digest) {
    fail(`read back a different envelope: ${readBack.envelope.digest} instead of ${envelope.digest}`);
  }
  console.log('');
  console.log(`verified via ${values['read-bee']}: digest ${readBack.envelope.digest} matches`);
}

class WriteFailure extends Error {}

/**
 * Unwinds and sets the exit code rather than calling `process.exit`: tearing the
 * process down while an HTTP socket is still closing aborts inside libuv on Windows.
 */
function fail(message: string): never {
  throw new WriteFailure(message);
}

try {
  await writeFeed();
} catch (error) {
  const message = error instanceof WriteFailure ? error.message : String(error);
  console.error(`write-feed: ${message}`);
  process.exitCode = 1;
}
