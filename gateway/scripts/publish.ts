import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';

import { isHex, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { namehash } from 'viem/ens';

import { PUBLISH_TYPES, publishDomain } from '../src/admin.ts';
import { envelopeDigest } from '../src/envelope.ts';

/**
 * Publishes an envelope under a name.
 *
 * The envelope file is sent **verbatim** — this tool does not reformat it, because
 * the digest the owner signs is over exactly these bytes and the gateway serves
 * exactly these bytes back. Produce the file with `canonicalize()` from `@zegel/sdk`
 * so its digest is the one every other module computes.
 *
 * The signing key is the ENS name owner's. It never leaves this process.
 */
async function publish(): Promise<void> {
  const { values } = parseArgs({
    options: {
      gateway: { type: 'string', default: 'http://localhost:8787' },
      name: { type: 'string' },
      node: { type: 'string' },
      envelope: { type: 'string' },
      key: { type: 'string' },
      'chain-id': { type: 'string', default: '1' },
      nonce: { type: 'string' },
      ttl: { type: 'string', default: '300' },
    },
  });

  const key = values.key ?? process.env['ZEGEL_PUBLISHER_KEY'];
  if (!key || !isHex(key) || key.length !== 66) {
    fail('pass the name owner key with --key 0x… or ZEGEL_PUBLISHER_KEY');
  }
  if (!values.envelope) fail('pass the envelope file with --envelope ./envelope.json');
  if (!values.name && !values.node) fail('pass --name alice.eth or --node 0x…');

  const node: Hex = values.node ? (values.node as Hex) : namehash(values.name as string);
  if (!isHex(node) || node.length !== 66) fail('--node must be 32 bytes of 0x-prefixed hex');

  // Trailing newlines are what an editor adds and a digest notices.
  const envelope = readFileSync(values.envelope, 'utf8').replace(/\s+$/u, '');
  const account = privateKeyToAccount(key);
  const now = Math.floor(Date.now() / 1000);
  // Seconds since the epoch: monotonic without keeping a counter anywhere.
  const nonce = values.nonce ? BigInt(values.nonce) : BigInt(now);
  const validUntil = BigInt(now + Number(values.ttl));

  const signature = await account.signTypedData({
    domain: publishDomain(Number(values['chain-id'])),
    types: PUBLISH_TYPES,
    primaryType: 'PublishEnvelope',
    message: {
      node,
      envelopeDigest: envelopeDigest(envelope),
      gateway: await fetchSignerAddress(values.gateway),
      nonce,
      validUntil,
    },
  });

  const response = await fetch(new URL('/admin/envelopes', values.gateway), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      node,
      ...(values.name ? { name: values.name } : {}),
      envelope,
      nonce: nonce.toString(),
      validUntil: validUntil.toString(),
      signature,
    }),
  });

  const body: unknown = await response.json().catch(() => ({}));
  if (!response.ok) fail(`${response.status} ${JSON.stringify(body)}`);

  console.log(`published as ${account.address}`);
  console.log(JSON.stringify(body, null, 2));
}

/**
 * The signature is bound to the gateway that will hold it, so the address comes from
 * that gateway rather than from a flag someone can get subtly wrong.
 */
async function fetchSignerAddress(gateway: string): Promise<Hex> {
  const response = await fetch(new URL('/health', gateway));
  const health = (await response.json()) as { signer?: string };
  if (!health.signer || !isHex(health.signer)) {
    fail(`${gateway} did not report a signing address; is it a Zegel gateway?`);
  }
  return health.signer;
}

class PublishFailure extends Error {}

/**
 * Unwinds and sets the exit code rather than calling `process.exit`: tearing the
 * process down while an HTTP socket is still closing aborts inside libuv on Windows.
 */
function fail(message: string): never {
  throw new PublishFailure(message);
}

try {
  await publish();
} catch (error) {
  const message = error instanceof PublishFailure ? error.message : String(error);
  console.error(`publish: ${message}`);
  process.exitCode = 1;
}
