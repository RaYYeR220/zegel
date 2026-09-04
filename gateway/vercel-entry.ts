/// <reference types="node" />
import type { IncomingMessage, ServerResponse } from 'node:http';

import { Hono } from 'hono';

import { createGatewayApp } from './src/app.ts';
import { loadConfig } from './src/config.ts';
import { createStatelessStore } from './src/store/factory.ts';

/**
 * Vercel entry point.
 *
 * Serverless means no disk and no memory that survives an invocation, so the store
 * defaults to `swarm-feed`: the gateway reads the current envelope out of a Swarm
 * feed on every request and holds nothing of its own. There is nothing to migrate,
 * nothing to back up, and no instance that knows something its siblings do not.
 *
 * The app is mounted twice on purpose. `vercel.json` rewrites every path to the
 * function, and whether the platform hands it the original path or the rewritten one
 * is not something to discover in production — the resolver's `gatewayUrls()` is on
 * chain and cannot be corrected quickly. Both spellings route to the same app.
 */
const gateway = createGatewayApp(
  loadConfig({ env: process.env, store: createStatelessStore(process.env) }),
);

const app = new Hono().route('/', gateway).route('/api', gateway);

/**
 * Node-runtime adapter.
 *
 * Written out rather than imported: `hono/vercel` targets the Edge runtime and
 * assumes a Web `Request`, while `@hono/node-server` dropped its `/vercel` subpath in
 * v2. Both failures surface only once deployed — the first as
 * `this.raw.headers.get is not a function` — so the twenty lines are worth it.
 */
export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const host = req.headers.host ?? 'localhost';
  const request = new Request(`https://${host}${req.url ?? '/'}`, {
    method: req.method ?? 'GET',
    headers: toHeaders(req),
    ...(req.method === 'GET' || req.method === 'HEAD' ? {} : { body: await readBody(req) }),
  });

  const response = await app.fetch(request);

  res.statusCode = response.status;
  response.headers.forEach((value, key) => res.setHeader(key, value));
  res.end(Buffer.from(await response.arrayBuffer()));
}

function toHeaders(req: IncomingMessage): Headers {
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    // Node keeps repeated headers as an array; Headers wants them appended.
    if (Array.isArray(value)) for (const item of value) headers.append(key, item);
    else headers.set(key, value);
  }
  return headers;
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}
