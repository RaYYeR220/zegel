# `@zegel/seal`

The access-control layer of Zegel.

Zegel issues a private financial reference: a claim about your on-chain history that
one named counterparty can read, for a while, and then cannot. This package is the
part that makes "cannot" true.

It is deliberately **not** the ENS gateway. A CCIP-Read gateway cannot enforce read
access — the caller is never authenticated (`sender` in `OffchainLookup` is the
resolver, `eth_call` is unsigned, and through the UniversalResolver `msg.sender` is
the UR), so any signed gateway response is a bearer token that anyone can replay
until it expires. The gateway therefore serves only public metadata. The
confidentiality is **Swarm's Access Control Trie**: content encrypted to a specific
set of secp256k1 public keys, where a reader without a grant gets a `404` that is
byte-identical to the answer for content that never existed.

---

## Threat model

### What is protected

The **contents** of a financial reference: the derived claims (tier 1) and the full
evidence bundle including the wallet address and the raw upstream responses
(tier 2). Each tier is a separate ACT-sealed object with its own grantee list, so
granting someone the claims does not grant them the address.

What is **not** protected is the *existence* of a reference. The public envelope
under the ENS name reveals that a reference exists, when it expires, its commitment
hash, and where the ciphertext lives. That is the deliberate trade: discovery has to
be public for the counterparty to find anything at all.

### From whom

| Adversary | Outcome |
|---|---|
| The public internet, given only the ENS name | Sees the envelope: a commitment, an expiry, a Swarm reference. Reading the reference returns `404`. Learns that a reference exists and nothing about its contents. |
| A chain-analytics firm scraping ENS | Same as above. The wallet address never appears in any public record; it exists only inside the tier-2 ciphertext. |
| The CCIP-Read gateway operator (us) | Can censor — refuse to serve the envelope, so the name stops resolving. Cannot read the sealed content and cannot forge it: the commitment is a hash of the canonical claim set and the content is encrypted to keys the gateway does not hold. Degradation is "the name stops working", never "wrong data". |
| A revoked grantee | Cut off from every version sealed *after* the revocation. Keeps what they already downloaded, and can still fetch the versions they were granted by supplying that timestamp. See **Revocation is forward-only**. |
| A granted grantee | Learns everything at their tier, permanently. Privacy here is from the world, not from the counterparty — exactly like handing a landlord a bank statement. The point is that the whole world does not also get it, forever. |
| The Swarm network at large | Sees ciphertext chunks. ACT encrypts at chunk level; without the access key the chunks are undifferentiated bytes. |
| **The public Swarm gateway operator** | **Can read anything sealed through the `gateway` backend.** See below — this is the one place where the guarantee is materially weaker, and it is why the `node` backend exists. |

### How

ACT derives, for each grantee, a session key by Diffie-Hellman between the grantee's
public key and the publisher's private key. From the session key it derives a lookup
key and an access-key-decryption key. The content's access key is encrypted
separately for every grantee and stored in a mantaray manifest keyed by lookup key —
so the grantee list itself is encrypted, and only the publisher can enumerate it.

A reader needs three values, all delivered out of band:

1. the Swarm reference,
2. the ACT **publisher** public key,
3. the ACT **history address**.

Zegel's answer to "out of band" is ENS: the envelope under the name carries all
three publicly, because none of them is a secret. What is secret is the grantee's
private key, which never leaves the grantee's own Bee node.

---

## The two backends, and what each actually guarantees

```ts
const client = await createSealClient({ kind: 'auto', keep: fileKeeper('.zegel/receipts.jsonl') })
client.caps
// { kind, url, canManageGrantees, canManagePostage, canUnseal,
//   usesNullStamp, confidentiality, limitations[] }
```

`kind: 'auto'` prefers a Bee node at `ZEGEL_BEE_URL` (default `http://localhost:1633`)
and falls back to the public gateway. Nothing degrades silently: every missing
capability is a `false` on `caps` plus a sentence in `caps.limitations`, and every
operation that cannot be honoured throws a named error rather than doing less than
asked.

### `gateway` — nodeless

`https://api.gateway.ethswarm.org` accepts uploads stamped with the **all-zeros
batch id**. No node, no postage, no xBZZ, no gift code. `swarm-act: true` works and
returns a history address.

`confidentiality: 'obscurity'`. Verified live 2026-09-03:

- `POST /bytes` with `swarm-act: true` and the null batch → `201` plus a
  `swarm-act-history-address` header.
- `GET /bytes/{ref}` with no credentials → `404 {"code":404,"message":"Not Found"}`,
  identical to a reference that was never uploaded.
- `POST /grantee` → **404.** Grantee-list management is not exposed. `grant`,
  `revoke` and `listGrantees` therefore throw `GranteeManagementUnavailableError`
  here, and `seal` with a non-empty grantee list throws by default rather than
  sealing an object nobody was actually granted. Pass
  `whenGranteesUnsupported: 'defer'` to seal anyway; the receipt then carries the
  requested keys under `grantees.deferred` and a warning is emitted.
- `GET /chainstate` and `GET /stamps` → **404.** No real postage, so no paid TTL:
  data on the null batch has no funded lifetime and no persistence guarantee. Never
  let the gateway hold the only copy.
- `GET /addresses` → **404.** This is the important one: the ACT publisher for a
  gateway upload is the *gateway's own node key*, and the gateway does not expose it.
  So an object sealed through the gateway **cannot be read back through the gateway**
  unless the publisher key is supplied out of band (`actPublisher`, or
  `ZEGEL_ACT_PUBLISHER`). `caps.canUnseal` reports `false` and `seal` warns.

  And when the key *is* known, the gateway node holds the matching private key and
  will decrypt for anyone who presents the three coordinates. That is secrecy of
  three out-of-band values, not key-bound access control. It is labelled
  `'obscurity'` for that reason and must not be counted as privacy.

  One caveat on the 404 indistinguishability: a caller who supplies a *correct*
  history address with a *wrong* publisher gets `{"message":"act or history entry not
  found"}` instead of the bare `Not Found`. That distinguishes "an ACT lives here"
  from "nothing lives here" — but only for someone who already holds the history
  address, which is one of the three coordinates. An adversary holding only the
  reference sees the identical `404`.

### `node` — our own Bee

A Bee node at `http://localhost:1633` (light mode is enough to upload).

`confidentiality: 'key-bound'`. Full `/grantee` support, real postage read from the
live `/chainstate`, and — the reason it matters — the publisher private key is ours.
Grantees decrypt on **their own** node with **their own** key, so possession of the
three public coordinates is not sufficient to read. This is the configuration the
privacy claim is actually about.

---

## Honest limits

These are stated first, in the code and in the demo, because they are true.

### Revocation is forward-only

Swarm's own documentation: *"grantees will be able to retrieve the content version
they were granted access to (using the relevant timestamp), even if their access to
newer versions were revoked."*

Concretely:

- A grantee who already downloaded a version **keeps it**. Nothing can be unsent.
- Historical ACT versions stay reachable at the timestamp they were granted.
  `unseal(..., { actTimestamp })` is exposed rather than hidden, because hiding it
  would misrepresent what revocation does.
- `revoke()` changes who can open versions sealed **from here on**. Its result carries
  `rotationRequired: true` as a reminder that the currently-published bytes are still
  open to the removed key until you `reseal()` them under the post-revocation history.

The demo is honest about this: after revoke-and-reseal, the revoked verifier resolves
the ENS name, gets the *new* reference, and receives a `404`. They keep whatever they
saved earlier. There is no API in this package that implies otherwise, and there will
not be one.

### The publisher can always read

The publisher key is one end of every ECDH in the trie. There is no configuration in
which the issuer is locked out of their own reference. Only the publisher can read or
modify the grantee list — `listGrantees` returns `null` for anyone else, because Bee
answers them with `404` too.

### Losing the history address is permanent

There is no recovery path. Not from the reference, not from the publisher key, not
from Swarm. The content becomes ciphertext that answers every request with `404`,
including yours.

This package is built so that outcome is hard to reach:

- `seal` returns a `SealReceipt` carrying all three coordinates as one value, and
  every read/grant/revoke takes that value — there is no call shape that accepts a
  reference without a history address.
- `SealClientOptions.keep` is **required**, not optional. The client cannot be
  constructed without a persistence sink, and the sink is awaited before `seal`
  resolves, so the history address is durable before the caller ever sees the
  reference. A throwing sink fails the seal.
- `HistoryAddress` and `SwarmReference` are distinct branded types. Swapping them is a
  compile error rather than a `404` you debug for an afternoon.

### Grantee patches are rate-limited to about one per second

Bee keys each ACT history version on the wall-clock second of the write. Two patches
inside the same second collide on the mantaray key and the second one fails with an
invalid-input error. Every grantee write in this package goes through a serialised
`PatchQueue` with a **1100 ms floor measured from the completion of the previous
patch**. The queue depth is public — `client.pendingPatches`, `client.nextPatchInMs`
and `client.onQueueDepthChange(...)` — so a UI can show "3 pending, next in 0.8s"
instead of appearing frozen for five seconds during a five-verifier grant.

### Postage is what keeps the data alive

`depth` is capacity, `amount` is duration, and the batch **TTL is the lifetime of the
reference**. When a batch expires its chunks stop being replicated and the reference
stops resolving — from the outside that is indistinguishable from a revocation. The
storage price is never hardcoded; `readStoragePrice` reads `currentPrice` from
`GET /chainstate` on every quote. Depth 17 is right for reference-sized data
(~44 kB effective). `ensureUsableBatch` reuses before it buys, and buys only when
`allowPurchase` is set, because spending xBZZ should be a decision rather than a side
effect.

### Swarm has no grantee discovery

*"a drive owner can grant access to a grantee, but the grantee has no way to know —
there's no notification, no inbox, no discovery mechanism."* Zegel's answer is ENS:
the name is the discovery channel for the three public coordinates. That is the seam
this project closes, and it is worth naming because Swarm named it first.

---

## Usage

```ts
import {
  createSealClient,
  coordinatesOf,
  fileKeeper,
  granteeFromSignedMessage,
  toSealedTier,
} from '@zegel/seal'

const client = await createSealClient({
  kind: 'auto',
  keep: fileKeeper('.zegel/receipts.jsonl'),   // required — see "Losing the history address"
  onWarning: console.warn,
})

// A verifier proves control of a key by signing one message; no private key changes hands.
const verifier = granteeFromSignedMessage('zegel: grant me a reference', signature)

const tier1 = await client.seal(claimSet, [verifier], { referenceId, tier: 1 })
const tier2 = await client.seal(evidenceBundle, [verifier], { referenceId, tier: 2 })

// Goes into the public ENS envelope. Throws if the publisher key is unknown,
// rather than publishing a tier nobody can open.
envelope.tiers = [toSealedTier(tier1), toSealedTier(tier2)]

// The verifier reads from their own node.
const result = await client.unseal<ClaimSet>(coordinatesOf(tier1))
if (result.granted) render(result.payload)
else showNotGranted()          // 404: revoked, never granted, or never existed

// Cut them off from here on, then rotate the live bytes.
await client.revoke(tier2, [verifier])
const rotated = await client.reseal(tier2, evidenceBundle)
```

`unseal` returns `Unsealed<T>` from `@zegel/sdk`:
`{ granted: true, payload } | { granted: false, reason: 'not-granted-or-absent' }`.
A missing grant is a value, never an exception — because at the protocol level it is
an answer, and one that is indistinguishable from absence. Faults (unreachable node,
malformed envelope, unknown publisher) still throw.

### Environment

| Variable | Meaning | Default |
|---|---|---|
| `SWARM_GATEWAY_URL` | Public gateway | `https://api.gateway.ethswarm.org` |
| `ZEGEL_BEE_URL` / `BEE_API_URL` | Our Bee node | `http://localhost:1633` |
| `ZEGEL_POSTAGE_BATCH_ID` | Batch to stamp uploads with | reuse or buy |
| `ZEGEL_ACT_PUBLISHER` | Publisher key when the endpoint will not report one | unset |

---

## API

| Export | What it does |
|---|---|
| `createSealClient(options)` | Probes the backend and returns a ready client. `keep` is required. |
| `client.caps` | What this backend can actually do, plus prose limitations. |
| `client.seal(payload, granteeKeys, opts)` | Canonical-JSON envelope, ACT upload, receipt persisted before it resolves. |
| `client.unseal(coordinates, opts)` | `Unsealed<T>`. `actTimestamp` selects a historical version. |
| `client.unsealEnvelope(...)` | As above, returning the whole envelope. |
| `client.grant / revoke / patchGrantees` | Queued grantee-list writes with the 1.1 s floor. |
| `client.reseal(receipt, payload)` | Rewrites the content under the current history — what actually closes a revocation. |
| `client.listGrantees(receipt)` | Publisher-only; `null` when Bee answers 404. |
| `client.pendingPatches` / `nextPatchInMs` / `onQueueDepthChange` | Queue observability. |
| `granteePublicKey` / `tryGranteePublicKey` / `isGranteePublicKey` | Validate and normalise a 66-hex compressed key, including an on-curve check. |
| `granteeFromSignedMessage` / `granteeFromPrivateKey` / `granteeFromUncompressed` | Derive a grantee identity from a wallet signature, a private key, or an uncompressed key. |
| `granteeAddress` | The Ethereum address a key maps to. Display only — ACT keys on the key. |
| `readStoragePrice` / `quoteBatch` / `ensureUsableBatch` / `waitForUsableBatch` | Postage, priced live. |
| `encodeEnvelope` / `decodeEnvelope` | The on-Swarm wrapper, digest-checked on decode. |
| `memoryKeeper` / `fileKeeper` / `allKeepers` | Receipt sinks. |
| `PatchQueue` | The rate floor, usable standalone. |

Errors: `GranteeManagementUnavailableError`, `PublisherUnknownError`,
`PostageUnavailableError`, `InvalidPublicKeyError`, `EnvelopeError`,
`BackendUnreachableError` — all extending `SealError` with a stable `code`.

---

## Tests

```
pnpm --filter @zegel/seal test
```

**82 passing, 1 skipped.** The skip is the local-Bee-node round trip, which runs only
when a node answers at `ZEGEL_BEE_URL`.

Unit coverage: the patch queue (ordering, the 1.1 s floor on a virtual clock and on a
real one, depth observability, rejection recovery), public-key validation and
recovery (cross-checked against `viem`), envelope encode/decode round-trips and
tamper detection, postage arithmetic against a live-price fixture, receipt/reference
branding, and the client's degradation paths against an in-memory Bee double.

Live coverage: `test/live.gateway.test.ts` runs against the real public Swarm
gateway with no mocks. It uploads with ACT and the null stamp, asserts a history
address comes back, asserts that an un-credentialed read of the sealed reference
returns exactly the same `404` body as a reference that was never uploaded, asserts
`POST /grantee` is 404 there, and asserts `GET /addresses` is 404 — so the documented
publisher limitation is enforced by a test rather than by prose. It skips itself when
the gateway is unreachable, never by asserting less.

## Version notes

Pinned to `@ethersphere/bee-js@13.0.0`, which uses the **namespaced** API
(`bee.data.upload`, `bee.file.upload`, `bee.grantee.create/.get/.patch`,
`bee.stamp.*`, `bee.connectivity.getNodeAddresses`). Every code sample published
before August 2026 — including Swarm's own quickstart skills — uses the v12 flat API
(`bee.uploadFile`, `bee.createGrantees`) and will not run.

Two details that silently break things if got wrong:

- The publisher key is `getNodeAddresses().publicKey`, **not** `pssPublicKey`. They
  are different keys on the same node; substituting the latter produces a grant that
  looks correct and decrypts nothing.
- A grantee is a compressed secp256k1 public key (`^[A-Fa-f0-9]{66}$`), not an
  Ethereum address. An address is a hash and cannot take part in the ECDH step, so
  the two are not interchangeable however similar they look in a config file.

`bee.stamp.waitForUsable` exists in 13.0.0 but is declared `private`, so
`waitForUsableBatch` in this package reimplements the poll.
