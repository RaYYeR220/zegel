import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { getAddress, isAddress, isHex, type Address, type Hex } from 'viem';

import { publishEnvelope, type PublishRequest } from './admin.ts';
import { decodeQuery, encodeResponse, encodeResult } from './ccip.ts';
import type { GatewayConfig } from './config.ts';
import { GatewayError, badRequest, gone, notFound } from './errors.ts';
import { buildHealthReport } from './health.ts';

export interface LookupResult {
  readonly data: Hex;
  readonly expires: number;
  readonly maxAge: number;
}

/**
 * The CCIP-Read gateway for `ZegelResolver`.
 *
 * It serves exactly one thing: the public sealed envelope for a name. That is a
 * commitment hash, an expiry, Swarm references and an anchor pointer — metadata
 * *about* ciphertext, never the ciphertext's contents and never a key.
 *
 * This is not a limitation being worked around. ERC-3668 cannot authenticate the
 * reader: `sender` is the resolver contract, `eth_call` is unsigned, and through the
 * UniversalResolver `msg.sender` is the UniversalResolver. A resolver that verifies
 * a *signer* — the only design that works — makes every response a replayable bearer
 * token until it expires. So this gateway is given nothing worth stealing. The
 * confidentiality lives in Swarm ACT, which encrypts to a named recipient's key and
 * needs no HTTP authentication to be sound.
 *
 * What the operator can do: refuse to answer. What the operator cannot do: read the
 * reference, or forge one.
 */
export function createGatewayApp(config: GatewayConfig): Hono {
  const app = new Hono();

  // ENSIP-22 requires a resolver's gateway to serve CORS, and a browser wallet
  // resolving through this gateway fails silently without it: the fetch is blocked
  // before any of our code runs, so the only symptom is a name that will not resolve.
  app.use(
    '*',
    cors({
      origin: '*',
      allowMethods: ['GET', 'POST', 'OPTIONS'],
      allowHeaders: ['Content-Type'],
      maxAge: 86_400,
    }),
  );

  app.get('/', (c) =>
    c.json({
      service: 'zegel-gateway',
      serves: config.envelopeKey,
      trustModel:
        'Serves the public sealed envelope only. The operator can censor; it cannot read the reference or forge one. Confidentiality is Swarm ACT, not this gateway.',
      routes: {
        lookup: ['GET /v1/:sender/:data', 'POST /v1/:sender'],
        envelope: 'GET /envelopes/:node',
        publish: 'POST /admin/envelopes',
        health: 'GET /health',
      },
    }),
  );

  app.get('/health', async (c) => {
    const report = await buildHealthReport(config);
    c.header('Cache-Control', 'no-store');
    return c.json(report, report.status === 'down' ? 503 : 200);
  });

  // ERC-3668: a `url()` template containing `{data}` is fetched with GET. Clients must
  // support both shapes, and which one they use is the resolver author's choice, so
  // both are mandatory here.
  app.get('/v1/:sender/:data', async (c) => {
    const sender = requireAddress(c.req.param('sender'), 'sender');
    // Deployed resolvers conventionally template `.../{sender}/{data}.json`, and the
    // suffix arrives as part of the path parameter.
    const raw = c.req.param('data').replace(/\.json$/i, '');
    return respond(c, await serveLookup(config, sender, requireCallData(raw)));
  });

  // No `{data}` in the template means POST, with both fields in the body.
  app.post('/v1/:sender', async (c) => {
    const sender = requireAddress(c.req.param('sender'), 'sender');
    const body = await readJsonBody(c.req.raw);
    return respond(c, await serveLookup(config, sender, requireCallData(readString(body, 'data')), body));
  });

  // A template with neither placeholder is legal too; then the sender is body-only.
  app.post('/v1', async (c) => {
    const body = await readJsonBody(c.req.raw);
    const sender = requireAddress(readString(body, 'sender'), 'sender');
    return respond(c, await serveLookup(config, sender, requireCallData(readString(body, 'data'))));
  });

  /**
   * The envelope as JSON, for clients that already trust the name and only want the
   * payload. It carries no signature and no on-chain binding, so it is a
   * convenience, not a substitute for resolving through the resolver.
   */
  app.get('/envelopes/:node', async (c) => {
    const node = requireNode(c.req.param('node'));
    const record = await config.store.get(node);
    if (!record) throw notFound(`no envelope published for node ${node}`);

    c.header('Cache-Control', `public, max-age=${config.cacheTtlSeconds}`);
    return c.json({
      node: record.node,
      name: record.name,
      publishedAt: record.publishedAt,
      publisher: record.publisher,
      digest: record.envelope.digest,
      expired: record.envelope.expiresAtSeconds <= config.now(),
      envelope: record.envelope.envelope,
    });
  });

  app.post('/admin/envelopes', async (c) => {
    if (!config.store.writable) {
      // Refuse before authenticating: a signature verified and then discarded would
      // look like an authorisation failure to whoever sent it.
      throw new GatewayError(
        501,
        `this gateway's store (${config.store.kind}) is read-only, so it cannot accept a publish: ${config.store.description}`,
      );
    }
    const body = await readJsonBody(c.req.raw);
    const record = await publishEnvelope(config, readPublishRequest(body));
    return c.json(
      {
        node: record.node,
        name: record.name,
        key: config.envelopeKey,
        digest: record.envelope.digest,
        nonce: record.nonce.toString(),
        publishedAt: record.publishedAt,
        publisher: record.publisher,
        expiresAt: record.envelope.envelope.expiresAt,
      },
      201,
    );
  });

  app.notFound((c) => c.json({ message: `no route for ${c.req.method} ${new URL(c.req.url).pathname}` }, 404));

  app.onError((error, c) => {
    if (error instanceof GatewayError) {
      return c.json({ message: error.message }, error.status as ContentfulStatusCode);
    }
    // Anything unclassified is our fault, and 5xx is what tells the client to try the
    // next gateway URL rather than giving up on the name.
    console.error('[zegel-gateway] unhandled error', error);
    return c.json({ message: 'internal gateway error' }, 500);
  });

  return app;
}

/**
 * Resolves one CCIP-Read query into a signed response.
 *
 * Failure is loud on purpose. When there is no envelope for a node we return 404
 * rather than signing an empty answer, because a signed "there is no reference here"
 * is indistinguishable, to the client, from "our storage lost it" — and the one
 * failure mode this design refuses is degrading to *wrong data* instead of to a name
 * that stops resolving.
 */
export async function serveLookup(
  config: GatewayConfig,
  sender: Address,
  callData: Hex,
  body?: Record<string, unknown>,
): Promise<LookupResult> {
  if (body && 'sender' in body) {
    const declared = readString(body, 'sender');
    if (!isAddress(declared) || getAddress(declared) !== sender) {
      throw badRequest(`the sender in the body (${declared}) does not match the sender in the path (${sender})`);
    }
  }

  if (config.resolvers.length > 0 && !config.resolvers.some((known) => known === sender)) {
    throw notFound(`this gateway does not serve resolver ${sender}`);
  }

  const query = decodeQuery(callData);
  if (query.key !== config.envelopeKey) {
    throw notFound(`this gateway serves only the "${config.envelopeKey}" data key, not "${query.key}"`);
  }

  const record = await config.store.get(query.node);
  if (!record) {
    throw notFound(`no envelope published for node ${query.node}`);
  }

  const now = config.now();
  if (record.envelope.expiresAtSeconds <= now) {
    // Not a policy choice. The callback enforces `expires >= block.timestamp`, and we
    // will not sign an `expires` past the envelope's own expiry, so for an expired
    // envelope there is no value of `expires` that is both honest and acceptable.
    throw gone(
      `the envelope for node ${query.node} expired at ${record.envelope.envelope.expiresAt}; no signable response exists for it`,
    );
  }

  const expires = Math.min(now + config.signatureTtlSeconds, record.envelope.expiresAtSeconds);
  const result = encodeResult(query, record.envelope.bytes);
  const signature = await config.signer.signResponse(sender, BigInt(expires), callData, result);

  return {
    data: encodeResponse(result, BigInt(expires), signature),
    expires,
    maxAge: Math.max(0, Math.min(config.cacheTtlSeconds, expires - now)),
  };
}

interface JsonContext {
  header(name: string, value: string): void;
  json(value: unknown, status?: ContentfulStatusCode): Response;
}

function respond(c: JsonContext, result: LookupResult): Response {
  // A cached response must never outlive the signature inside it.
  c.header('Cache-Control', `public, max-age=${result.maxAge}`);
  return c.json({ data: result.data });
}

async function readJsonBody(request: Request): Promise<Record<string, unknown>> {
  let parsed: unknown;
  try {
    parsed = await request.json();
  } catch (cause) {
    throw badRequest('request body is not valid JSON', { cause });
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw badRequest('request body is not a JSON object');
  }
  return parsed as Record<string, unknown>;
}

function readString(body: Record<string, unknown>, field: string): string {
  const value = body[field];
  if (typeof value !== 'string') throw badRequest(`"${field}" is missing or not a string`);
  return value;
}

function requireAddress(value: string, field: string): Address {
  if (!isAddress(value)) throw badRequest(`"${field}" is not a 20-byte hex address`);
  return getAddress(value);
}

function requireCallData(value: string): Hex {
  if (!isHex(value)) throw badRequest('"data" is not 0x-prefixed hex');
  if (value.length % 2 !== 0) throw badRequest('"data" has an odd number of hex digits');
  return value;
}

function requireNode(value: string): Hex {
  if (!isHex(value) || value.length !== 66) throw badRequest('node is not 32 bytes of 0x-prefixed hex');
  return value.toLowerCase() as Hex;
}

function readPublishRequest(body: Record<string, unknown>): PublishRequest {
  const name = body['name'];
  if (name !== undefined && name !== null && typeof name !== 'string') {
    throw badRequest('"name" must be a string when present');
  }
  const signature = readString(body, 'signature');
  if (!isHex(signature)) throw badRequest('"signature" is not 0x-prefixed hex');

  return {
    node: requireNode(readString(body, 'node')),
    name: typeof name === 'string' ? name : null,
    envelope: readString(body, 'envelope'),
    nonce: readUint(body, 'nonce'),
    validUntil: readUint(body, 'validUntil'),
    signature,
  };
}

function readUint(body: Record<string, unknown>, field: string): bigint {
  const value = body[field];
  if (typeof value === 'number') {
    if (!Number.isInteger(value) || value < 0) throw badRequest(`"${field}" must be a non-negative integer`);
    return BigInt(value);
  }
  if (typeof value === 'string' && /^\d+$/.test(value)) return BigInt(value);
  throw badRequest(`"${field}" must be a non-negative integer, as a number or a decimal string`);
}
