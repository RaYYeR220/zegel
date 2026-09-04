# Zegel — CCIP-Read gateway

The off-chain half of `ZegelResolver`. It answers one question, for one record key:

> `data(node, "zegel.envelope.v1")` — what is the public sealed envelope for this name?

It is a **dumb pipe**, on purpose, and that is the strongest thing about it. It is
also **stateless**: the envelope lives in a Swarm feed, and this process holds no
database, no file and nothing worth backing up.

```bash
pnpm install
pnpm start          # http://localhost:8787
curl -s localhost:8787/health
```

No database, no credentials, no wallet. It runs with an empty environment and tells
you, in `/health`, exactly which parts of it are therefore not real yet.

---

## The trust model, stated first

**A CCIP-Read gateway cannot authenticate its caller.** Not "does not"; cannot. Four
independent facts, each verified against live mainnet rather than recalled:

- `sender` in ERC-3668's `OffchainLookup` is **the resolver contract**, not the
  reader. It is a routing field. (Decoded byte-for-byte from live reverts on
  `offchaindemo.eth` and `base.eth`.)
- `eth_call` **carries no signature.** `msg.sender` is whatever the caller puts in
  the JSON-RPC `from` field — free-form and spoofable — and ERC-3668's own security
  section tells application authors not to send it at all.
- Through the **UniversalResolver**, which is the path viem, ethers, wagmi and ensjs
  all take, `msg.sender` inside the resolver is the UniversalResolver.
- ENSIP-22 **requires** this gateway to serve `Access-Control-Allow-Origin: *`, so
  `Origin` and `Referer` gate nothing.

And then the structural one, which finishes the argument:

> If the callback verifies a **signer** — the only design that works — then every
> response this gateway emits is a **freely replayable bearer token** for that record
> until it expires. One authorised reader fetches once and can publish the signed
> blob; anyone holding it feeds it back through `resolveWithProof` and gets the same
> answer. **Signed therefore means public.**

There is no configuration of any resolver in which that stops being true. So this
gateway is never handed anything that needs protecting.

| | |
|---|---|
| **The operator can** | Censor. Refuse to answer, and the name stops resolving. Also: see the IP and TLS fingerprint of whoever looked the name up, and which name they looked up. |
| **The operator cannot** | Read the reference. The claims live in a Swarm ACT object encrypted to a named recipient's secp256k1 key; the gateway holds no key and never sees plaintext. |
| **The operator cannot** | Forge one. The envelope's `commitment` is a hash of the canonical claim set, anchored on Base and in a Solana attestation; a substituted envelope fails the commitment check and a substituted claim set fails the anchor. |
| **The operator cannot** | Roll one back. A publish is signed by the name's owner over a monotonic nonce, so an old envelope cannot be re-instated by replaying an old publish. |

> **Swarm ACT is the access control. This gateway is discovery.**

What it serves — the `SealedEnvelope` — is public by construction: a commitment hash,
an issue and expiry time, Swarm references, an ACT publisher key, and an anchor
pointer. It reveals that a reference exists and where to look. It reveals nothing
about the contents, and it never contains the subject's address. An un-granted read
of the Swarm object it points at returns **404, indistinguishable from a reference
that never existed**.

---

## What it does enforce

| Property | How |
|---|---|
| Authenticity | Responses are signed by a key the resolver's on-chain allowlist names. |
| Query binding | The signature covers `callData`, which carries the DNS-encoded name and the record key. A response for one name cannot be lifted onto another. |
| Resolver binding | The signature covers the resolver address. A response cannot move between two resolvers that trust the same signer. |
| Name/node agreement | On the `resolve()` path the gateway recomputes `namehash(name)` and refuses if it disagrees with the `node` in the inner call. Those are two independent fields and nothing upstream forces them to match. |
| Freshness | `expires` is capped at `min(now + 60s, envelope.expiresAt)` and enforced on chain against `block.timestamp`. |
| Publish authority | EIP-712, signed by the ENS name's owner, read from the registry. |
| Failure mode | Degrades to *the name stops resolving*, never to *the name resolves to something wrong*. |

---

## Where the envelope comes from

```
ENS name  ->  ZegelResolver (ERC-3668)  ->  this gateway  ->  Swarm feed  ->  envelope
```

A Swarm feed is a mutable pointer: an owner plus a topic resolves to the latest
update. Publishing is **writing the feed**, which happens on the issuer's own Bee node
— it needs a signing key and postage, neither of which this gateway has or should.
The gateway only ever reads, and reads on a public Bee gateway are free and
unauthenticated, so a deployment needs no node of its own.

That is what makes this process disposable. There is nothing to migrate, nothing to
back up, and no instance that knows something its siblings do not; run one, or fifty
serverless ones, or move it to a different host mid-demo. It also caps what an
operator is worth: the feed reads identically from **any** Bee node in the world, so a
censoring or vanished gateway costs you the relay and nothing else.

### The topic, derived from the name

```
topic = keccak256( utf8(dataKey) ‖ node )
```

`node` is the ENS namehash, `dataKey` is the ENSIP-24 record key. Nothing secret goes
in, deliberately: anyone holding the name can recompute the topic, fetch the feed
themselves, and check that this gateway is serving what the feed says. A relay you can
audit is worth more than one you have to trust.

Worked example, `alice.eth` under `zegel.envelope.v1`:

```
node   0x787192fc5378cc32aa956ddfdedbf26b24e8d78e40109add0eea2c1a012c3dec
topic  0xe2bdd8e5a9b5a5cf463ffd8e2e12d8c24adfaaefe5b2bb6750fc6a773f3ca4b5
```

```bash
curl https://api.gateway.ethswarm.org/feeds/<owner>/e2bdd8e5a9b5a5cf463ffd8e2e12d8c24adfaaefe5b2bb6750fc6a773f3ca4b5
```

That vector is pinned in `test/swarm-feed.test.ts`, because changing the derivation
silently orphans every feed already published.

### Following the pointer

A feed slot holds 4 KB, so the feed stores a **reference** and the envelope is
uploaded as ordinary Swarm content behind it. Bee 2.x resolves that server-side and
returns the content directly — verified live against both a local node and
`api.gateway.ethswarm.org` — but not every version and not every deployment will, so a
reference-shaped body (32 bytes, or 8 timestamp bytes followed by 32) is followed to
`/bytes/{reference}` rather than assumed away.

### When the feed cannot be read

An unreachable feed answers with the **same 404 as an unpublished name**. That
collapse is deliberate: the only alternative is signing an answer we could not verify,
and a signed response is a bearer token that outlives the moment it was minted. It is
not silent, though — the failure is recorded and `/health` degrades with the reason,
which is where the difference between "absent" and "unreachable" belongs.

Reads are cached for 15 seconds by default, and a cached envelope is never served past
its own `expiresAt`, however long the TTL. If the feed goes unreachable while a
still-valid envelope is cached, that envelope keeps being served — it is the same
content, and its own expiry still binds — and `/health` still reports the fault.

---

## The two request shapes

ERC-3668 makes both mandatory, and which one a client uses is decided by the
resolver's `url()` template, not by the client. Both are implemented.

```bash
# Template contains {data}  ->  GET.  The deployed convention appends `.json`.
GET /v1/{sender}/{data}.json

# Template has no {data}    ->  POST, both fields in the body.
POST /v1/{sender}      {"data":"0x…","sender":"0x…"}
POST /v1               {"data":"0x…","sender":"0x…"}
```

Both answer `200 {"data":"0x…"}`, where `data` is
`abi.encode(bytes result, uint64 expires, bytes signature)`.

### The asymmetry that breaks offchain resolvers silently

`ZegelResolver` reverts into the *same* callback from both of its entry points. The
gateway tells them apart by the leading selector of `callData`, and they need
different result encodings — because CCIP-Read substitutes the callback's return data
for the **original** call's return data:

| `callData` selector | Query | `result` must be |
|---|---|---|
| `0xecbfada3` | `data(node, key)` | the envelope bytes |
| `0x9061b923` | `resolve(name, data(node, key))` | `abi.encode(envelope)` |

Get this backwards and the response verifies on chain and then decodes to garbage in
the client. `test/encoding.test.ts` pins it in both directions, and
`test/contract.test.ts` proves it against the deployed contract.

### The signature

```
keccak256(0x1900 ‖ resolver ‖ expires ‖ keccak256(callData) ‖ keccak256(result))
```

EIP-191 version `0x00`, "intended validator" — the layout every ENS offchain resolver
has used since the reference implementation. 65 bytes, `v` in {27, 28}, low-`s` only:
`SignatureVerifier` refuses the mirrored signature so a response has exactly one
representation.

---

## Publishing an envelope

### Stateless: write the feed

The production path. Runs on the issuer's machine, next to their Bee node.

```bash
node scripts/write-feed.ts   --envelope ./envelope.json   --name alice.eth   --key 0x…            # the feed signing key; never leaves the process
  --batch <postage batch id>
```

It uploads the envelope, writes the feed update that points at it, prints the topic
and the `ZEGEL_FEED_OWNER` to configure, and then **reads it back through the public
gateway** to prove the deployed gateway will see it. Authority here is possession of
the feed key: a different key is a different feed, and the gateway reads exactly one
owner's.

### Stateful stores: the signed admin route

For the `file` and `memory` backends, where this gateway does hold the envelope. With
a `swarm-feed` store the route answers **501** up front — refusing before
authenticating, because a signature verified and then discarded looks to the caller
like an authorisation failure.

```bash
node scripts/publish.ts \
  --gateway http://localhost:8787 \
  --name alice.eth \
  --envelope ./envelope.json \
  --key 0x…            # the ENS name owner's key; never leaves the process
```

The route underneath is `POST /admin/envelopes`, authorised by an EIP-712 signature
from the **name's owner**, read from the ENS registry (`ZEGEL_RPC_URL`) or from a
configured map for local runs (`ZEGEL_NAME_OWNERS`). Contract-owned names — a Safe,
say — verify through ERC-1271 when an RPC is configured.

```solidity
PublishEnvelope(bytes32 node, bytes32 envelopeDigest, address gateway, uint64 nonce, uint64 validUntil)
```

**Why not an API key.** The resolver's gateway URL is public on chain —
`cast call <resolver> "gatewayUrls()(string[])"` prints it — so a credential embedded
in that string is a credential published to the world. Name ownership is the only
authority that is already public, already on chain, and already the right one.

Every field of that message is load-bearing:

- `envelopeDigest` is `sha256` over the exact bytes submitted, so the owner signs the
  bytes rather than a description of them.
- `gateway` is this gateway's signing address, so a publish cannot be replayed to a
  different operator — and operators are precisely the parties who see every publish
  go past.
- `nonce` must exceed the highest ever accepted for that node, and the ledger of
  nonces **outlives the record**. Without that, anyone who saw an earlier publish
  could replay it and roll the name back to a superseded envelope, which is how you
  would un-revoke a revoked reference.
- `validUntil` is capped at one hour out: an authorisation good for longer is a
  standing permission, not a publish.

**The gateway never re-serialises the envelope.** It stores the submitted text and
serves those bytes back, byte for byte, because that is what the owner's digest
covers. Produce the file with `canonicalize()` from `@zegel/sdk` so its digest is the
one every other module computes; `test/encoding.test.ts` asserts the two agree.

`GET /envelopes/:node` returns the same envelope as plain JSON — convenient for a UI,
but unsigned and unbound to any chain, so it is not a substitute for resolving
through the resolver.

---

## Expiry and caching, and the trade

`expires` defaults to **60 seconds** out, and is further capped at the envelope's own
`expiresAt`. HTTP `Cache-Control: max-age` defaults to 30 and is clamped to never
outlive the signature inside the response.

The exposure a long window creates is not confidentiality — the payload is public and
costs nothing to hand out. It is **staleness**: a signed response stays replayable
until `expires`, so a superseded or revoked envelope keeps resolving for that long.
Sixty seconds is short enough that a revocation is visible almost immediately, and
long enough to survive an RPC round trip plus a few seconds of clock skew between
this process and a validator. Below roughly 30 seconds, skew starts rejecting
responses that were honest when they were minted. Tune with `ZEGEL_SIGNATURE_TTL`.

An envelope whose own `expiresAt` has passed gets **410 Gone**, and this is not a
policy preference: the callback requires `expires >= block.timestamp` and the gateway
will not sign an `expires` beyond the envelope's expiry, so no value exists that is
both honest and acceptable.

A node with no published envelope gets **404**, not a signed empty answer. A signed
"there is no reference here" is indistinguishable, to the client, from "our storage
lost it" — and the one failure mode this design refuses is degrading to wrong data
instead of to a name that stops resolving.

---

## Storage

Behind one interface (`src/store/types.ts`), so the demo needs no database:

| Backend | Use |
|---|---|
| `SwarmFeedEnvelopeStore` | **The deploy path.** Reads the current envelope from a Swarm feed on every request and keeps nothing. Read-only: `writable` is false and the admin route refuses. |
| `FileEnvelopeStore` | A local run with a real disk. One JSON file; writes go to a temp file and are renamed into place, so a process killed mid-publish leaves the previous file intact. |
| `MemoryEnvelopeStore` | Tests, and a Worker seeded from `ZEGEL_ENVELOPES`. Reports itself as lossy-on-restart in `/health`. |

Choosing `file` from a serverless entry point throws at boot with a sentence saying
so, rather than losing every publish at the next cold start.

A corrupt or unreadable store is a **failure**, never an empty one: reading it throws
and `/health` goes `down`. "No envelopes published" and "I cannot read my envelopes"
must never look the same.

---

## `GET /health`

Modelled on Mobula's `/2/perp/dex-status`: probe the dependencies, report what you
found, and never claim green for something you did not check.

```json
{
  "status": "degraded",
  "service": "zegel-gateway",
  "signer": "0xB33D…c01E",
  "checks": [
    { "name": "signer", "status": "degraded", "detail": "0xB33D…c01E was generated at boot; no deployed resolver allowlists it" },
    { "name": "store", "status": "ok", "detail": "Swarm feed 0x1d75…74b8 via https://api.gateway.ethswarm.org, cached 15s; 1 envelope(s) held" },
    { "name": "resolver-allowlist", "status": "ok", "detail": "signing only for 0x…" },
    { "name": "name-ownership", "status": "skipped", "detail": "the swarm-feed store is read-only, so publish authority is the feed key, not this gateway" },
    { "name": "resolver-onchain", "status": "skipped", "detail": "no ZEGEL_RPC_URL, so the on-chain signer allowlist was not checked" }
  ],
  "warnings": ["…"]
}
```

- An unconfigured dependency is **`skipped`**, never `ok`.
- `store` failing with nothing held is `down`, and `/health` answers **503**. Failing
  while it still holds usable envelopes is `degraded`: a feed store whose Bee endpoint
  blipped can still answer, and calling that `down` would pull a working deployment out
  of rotation for a fault it is surviving.
- `name-ownership` is `skipped` for a read-only store, because nothing can be published
  through this gateway at all; authority moved to whoever holds the feed key.
- `resolver-onchain` is the check worth having: it reads `signers(address)` on the
  deployed resolver, so a gateway signing with a key the resolver does not trust says
  so, in one line, naming the `setSigner(...)` call that fixes it. Every other signal
  can be green while that one condition silently breaks resolution.

---

## Configuration

All optional; see `.env.example`.

| Variable | Default | Notes |
|---|---|---|
| `ZEGEL_SIGNER_KEY` | generated at boot | Required when `NODE_ENV=production`. A generated key makes `/health` degraded, because a key no resolver allowlists produces responses that revert. |
| `ZEGEL_RESOLVERS` | unrestricted | Comma-separated. Unset, the gateway signs for any resolver that asks, and says so. |
| `ZEGEL_CHAIN_ID` | `1` | Binds the EIP-712 publish domain. |
| `ZEGEL_RPC_URL` | — | Registry ownership, ERC-1271, and the on-chain signer check. Only the host is ever echoed back; RPC URLs carry keys. |
| `ZEGEL_ENS_REGISTRY` | `0x0000…2e1e` | |
| `ZEGEL_NAME_WRAPPER` | — | A wrapped `.eth` name has the NameWrapper as its registry owner; set this to follow the second hop. Configuration rather than a constant, because a wrong hardcoded address would present as "you do not own this name". |
| `ZEGEL_NAME_OWNERS` | — | `node=owner` pairs, for a local run with no RPC. |
| `ZEGEL_STORE` | `file` on the Node entry, `swarm-feed` everywhere else | `swarm-feed`, `file` or `memory`. |
| `ZEGEL_FEED_OWNER` | — | Required for `swarm-feed`. The address whose feed is authoritative; `scripts/write-feed.ts` prints it. |
| `ZEGEL_BEE_URL` | `https://api.gateway.ethswarm.org` | Bee API for feed reads. Free and unauthenticated on the public gateway. |
| `ZEGEL_FEED_CACHE_TTL` | `15` | Seconds. A cached envelope never outlives its own `expiresAt`. |
| `ZEGEL_STORE_PATH` | `.zegel/envelopes.json` | `file` backend only. |
| `ZEGEL_SIGNATURE_TTL` / `ZEGEL_CACHE_TTL` | `60` / `30` | Cache TTL is clamped to the signature TTL. |
| `ZEGEL_PORT` | `8787` | |

---

## Deploying

TypeScript runs directly on Node 24 — no build step, no bundler.

```bash
ZEGEL_SIGNER_KEY=0x… ZEGEL_RESOLVERS=0x… ZEGEL_RPC_URL=https://… \
NODE_ENV=production node src/index.ts
```

### Vercel

`api/[[...route]].ts` is the entry point and `vercel.json` rewrites every path into
it, so the on-chain gateway URL stays clean — `https://…/v1/{sender}/{data}.json`, no
`/api` in it. The app is mounted at both `/` and `/api` inside the function: whether a
platform hands a rewritten function the original path or the destination one is not
something to discover in production, when the URL that is wrong is already on chain.

Serverless means the store must be `swarm-feed`; `file` throws at boot with an
explanation. Set exactly these:

| Variable | Value |
|---|---|
| `ZEGEL_SIGNER_KEY` | the gateway signing key (mark it sensitive) |
| `ZEGEL_RESOLVERS` | the deployed `ZegelResolver` address |
| `ZEGEL_CHAIN_ID` | `1` |
| `ZEGEL_STORE` | `swarm-feed` |
| `ZEGEL_FEED_OWNER` | the feed owner address printed by `scripts/write-feed.ts` |
| `ZEGEL_BEE_URL` | `https://api.gateway.ethswarm.org` |
| `ZEGEL_RPC_URL` | a mainnet RPC — optional, but without it `/health` cannot check the on-chain signer allowlist |
| `NODE_ENV` | `production` — makes a missing `ZEGEL_SIGNER_KEY` a boot failure instead of a throwaway key |

`ZEGEL_STORE_PATH`, `ZEGEL_NAME_OWNERS` and `ZEGEL_NAME_WRAPPER` are not used by a
feed-backed deployment, and neither are the writer's `ZEGEL_FEED_KEY` and
`ZEGEL_POSTAGE_BATCH` — those belong on the issuer's machine and must never be set on
the gateway.

### Cloudflare Workers

`src/worker.ts` is the entry point (`wrangler.toml` is included;
`wrangler secret put ZEGEL_SIGNER_KEY`). Same store rules as Vercel: `swarm-feed` by
default, or a fixed set pinned into memory via `ZEGEL_ENVELOPES`.

Then wire the resolver, which is three transactions by two different parties:

```bash
# 1. The resolver owner allowlists this gateway's signing address.
cast send <resolver> "setSigner(address,bool)" <signer> true

# 2. The resolver owner points at this gateway. Public on chain — no API keys here.
cast send <resolver> "setGatewayUrls(string[])" '["https://gw.example/v1/{sender}/{data}.json"]'

# 3. The name's owner points the name at the resolver.
cast send 0x00000000000C2E074eC69A0dFb2997BA6C7d2e1e \
  "setResolver(bytes32,address)" <namehash> <resolver>
```

Then confirm the whole path, through the real client stack:

```bash
cast call <resolver> "data(bytes32,string)(bytes)" <namehash> "zegel.envelope.v1"
```

---

## Tests

```
pnpm test
```

```
test/swarm-feed.test.ts  25  topic derivation, pointer following, cache, unreachable feeds
test/lookup.test.ts      23  both request shapes, expiry capping, malformed calldata, refusals
test/encoding.test.ts    19  digest layout, low-s, selector routing, DNS names, envelope validation
test/admin.test.ts       15  EIP-712 publish, wrong signer, rollback, envelope validation
test/store.test.ts        9  memory and file backends, restart, corruption
test/health.test.ts       8  ok / degraded / down, skipped-not-ok
test/contract.test.ts     9  the real ZegelResolver on anvil  (+1 skip marker)
test/swarm-live.test.ts   4  live Swarm reads and a real feed round trip
test/cors.test.ts         3  preflight, success, error responses
test/vercel.test.ts       3  boots from env alone, both path spellings, CORS
                         ---
                         118 passed, 1 skipped
```

Two suites reach the outside world and both self-skip, loudly, as recorded tests:
the anvil cross-check below, and `test/swarm-live.test.ts`, which probes
`api.gateway.ethswarm.org` and — when a Bee node with a usable postage batch is
reachable — writes a feed with a throwaway key and reads the envelope back through the
same code the gateway uses.

### The cross-check against the real contract

`test/contract.test.ts` is the one that matters. Every other test checks the gateway
against the gateway's own understanding of the resolver; this one checks it against
the resolver.

It reads the compiled `ZegelResolver` from `contracts/out/`, deploys it to a local
**anvil**, starts this gateway on a real port, names that port in the resolver's
`gatewayUrls()`, and then asks **viem** to read the record. viem follows the
`OffchainLookup` revert, fetches this gateway over HTTP, and feeds the response back
through `resolveWithProof` — the entire ERC-3668 round trip, through the same client
stack a wallet uses. If the digest layout, the `v` encoding, the `s` normalisation,
the `expires` field or the `data()`/`resolve()` result wrapping were wrong in any
way, none of it passes.

It also asserts the adversarial cases *on chain*, against the deployed bytecode:

- a genuinely valid response **lifted onto another name** → `UnauthorizedSigner`
- `extraData` naming the **UniversalResolver** → `SenderMismatch`
- an **expired** response → `SignatureExpired`
- the owner **revoking the signer** mid-run → `UnauthorizedSigner`
- a node with **no envelope** → the lookup fails rather than resolving to nothing
- the `/health` on-chain probe against the live contract, in both the allowlisted and
  the not-allowlisted case

The suite skips itself, loudly and as a recorded test, if `anvil` is not on `PATH` or
`contracts/out/ZegelResolver.sol/ZegelResolver.json` is missing (`forge build` in
`contracts/`). A suite that vanishes when a tool is absent is a suite nobody notices
stopped running.

---

## Honest limits

1. **The operator can censor.** Nothing here prevents it. Degradation is "the name
   stops resolving", never "wrong data", and running two gateway URLs in the
   resolver's list makes a single operator less load-bearing — but a determined
   operator can always refuse.
2. **A signed response is a bearer token until `expires`.** By construction, not by
   oversight. The mitigation is that it carries nothing secret and expires in a
   minute.
3. **The gateway sees who is asking, at the network level.** IP, TLS fingerprint,
   `User-Agent`, and which name was queried. ERC-3668 names this as a privacy leak to
   be proxied away, and it is real. It learns nothing about the *reader's identity* in
   any trustworthy form — but "not trustworthy" is not "not observed".
4. **The feed key is a single point of authority.** Whoever holds it can publish any
   envelope under any name this gateway serves, because the gateway trusts one feed
   owner. That is the same trust the name's owner already places in their issuer, but
   it is trust, and it is not on chain.
5. **Postage is a clock.** Swarm content lives as long as its batch is funded. An
   envelope whose batch lapses stops being retrievable and the name stops resolving —
   loudly, in `/health`, but it stops. Top the batch up, or accept the expiry as the
   reference's expiry.
6. **Propagation is not instant.** A feed written on one node takes a moment to be
   readable from another. Publishing then resolving in the same breath can 404 once.
7. **An unreachable feed is indistinguishable from an unpublished name**, to a client.
   Deliberately — see above — with the difference visible in `/health`.
8. **`GET /envelopes/:node` is unauthenticated.** It has to be — the envelope is
   public by design — but it means node-by-node enumeration is possible for anyone who
   can guess a namehash. There is deliberately no listing endpoint.
