# `@zegel/app` — the booklet

A private financial reference, issued as a machine-readable travel document.

Four pages, numbered the way a passport numbers them, reachable at their own URLs:

| Page | Route | What it does |
|---|---|---|
| **03 Waarnemingen** | `/` | The dossier the surveillance industry already has. Live Mobula. No wallet, no key. |
| **05 Gegevens** | `/issue` | Prove control of a wallet, derive claims, seal both tiers, anchor the commitment. |
| **07 Visa** | `/access` | Who may read what. Grant, watch a real second node read it, revoke, watch it 404. |
| **09 Controle** | `/verify` | The recipient's desk. Resolve, re-derive, and refuse a forgery. |

The empty portrait window on page 05 is the product: every identity document reserves
that space for the one datum that opens everything behind it, and this one leaves it
hatched and stamped **wallet withheld**.

---

## Run it

```bash
cd zegel/app
npm install          # ~50 packages; the sibling workspaces are already installed
npm run dev          # http://localhost:3000
```

`npm run build && npm start` for the production server. `npm run typecheck` for
`tsc --noEmit`.

The sibling packages ship TypeScript source and no build artefact, the same
arrangement `cli/` uses. They are reached through `tsconfig.json` path aliases and
`experimental.externalDir`, and they resolve their own dependencies from their own
`node_modules` — so nothing here needs to be installed twice, and nothing needs
building first.

### What works with no credentials

Everything except issuing:

- **Page 03** — enter any address or ENS name. Resolution goes through ENSIP-15
  normalisation on a keyless public RPC; the dossier comes from Mobula's demo host,
  which needs no key and no signup.
- **Page 09** — resolve `zegel.eth` (or any name) and inspect what it publishes. The
  anchor is read from Base mainnet over a keyless RPC.
- **The health strip** at the foot of every page. Each pill is a request made in that
  moment, with the latency it took; hovering one says what its absence would cost you.
- **The credit meter**, from Mobula's own `x-ratelimit-cost` / `-limit` / `-remaining`
  headers on every response.

**Page 05 needs a browser wallet**, and that is the point: a reference is an assertion
about somebody's money, and the only person who may make it is the person who can sign
for the wallet. The server verifies an EIP-191 signature over
`Zegel reference <id>` and refuses anything else — there is no operator override and no
issue-on-behalf-of path.

**Pages 05 and 07 need a Bee node** for the parts that touch Swarm. Grantee lists live
behind `POST /grantee`, which the public Swarm gateway answers with 404, and the ACT
publisher private key has to belong to a node you run. When it is missing, sealing and
grant/revoke are **refused with the reason**, never simulated.

Demonstrating a *granted* read needs a **second** Bee node, because ACT decryption
happens inside Bee with the reader's own key and there is no browser implementation. An
unfunded ultra-light node is enough — reading costs nothing.

### Environment

Every variable has a working default; see `.env.example`. The ones that matter:

| Variable | Default | Effect when unset |
|---|---|---|
| `MOBULA_API_KEY` | — | Uses `demo-api.mobula.io`. Lower rate limits, no WebSocket. Nothing else changes. |
| `ETH_RPC_URL` | `ethereum-rpc.publicnode.com`, `eth.merkle.io` | Keyless fallbacks are used. |
| `BASE_RPC_URL` | `mainnet.base.org`, `base-rpc.publicnode.com` | Keyless fallbacks are used. |
| `ZEGEL_BEE_URL` | `http://127.0.0.1:1633` | Issuing and grant/revoke are refused. |
| `ZEGEL_BEE_READER_URL` | `http://127.0.0.1:1643` | The read panel says no reader node is running instead of showing an answer. |
| `ZEGEL_POSTAGE_BATCH_ID` | — | The seal layer finds a usable batch on the node, or buys one. |
| `NEXT_PUBLIC_ZEGEL_ANCHOR` | `0xbcB85eCdeF23a11D5015b260cC4eDCc0c250f42e` | The deployed anchor on Base mainnet. |
| `NEXT_PUBLIC_ZEGEL_NAME` | `zegel.eth` | Prefills the inspection desk. |

---

## Where the state lives

Nowhere on the server. There is no database and no filesystem write at runtime; every
route takes what it needs as an argument and forgets it.

An issued reference lives in the **issuer's own browser**, in `localStorage`, because the
ACT history address cannot be recovered from Swarm, from the reference, or from the
publisher key — so it belongs with the person who would lose access if it went missing.
The page says so. Clear the browser and the reference is gone.

The one thing that is *not* held locally is who may read: that is read back live from the
node's own ACT grantee list on every visit to page 07, so the ledger on screen is the
node's answer and not a copy of it.

---

## Routes

| Route | Shape | Notes |
|---|---|---|
| `GET /api/health` | JSON | Every dependency, probed now. |
| `POST /api/subject` | JSON | Address or ENS name → checksummed address. |
| `POST /api/exposure` | NDJSON stream | Progress, credits, then the dossier. |
| `POST /api/issue/prepare` | JSON | A reference id and the exact string to sign. |
| `POST /api/issue` | NDJSON stream | Verifies the control proof, collects, derives, seals both tiers. |
| `POST /api/access/list` | JSON | The live grantee list for one tier. |
| `POST /api/access/grant` | JSON | Patch the list, then write the content again under the new history. |
| `POST /api/access/revoke` | JSON | The same, with the opposite sign. |
| `POST /api/access/read` | JSON | The same object from three positions at once. |
| `POST /api/verify` | JSON | Resolve, open, re-derive, and rule. |

The two collection routes stream because the interesting part of a thirty-second
collection is *which* endpoint answered and what it cost — and because a tier-2 evidence
bundle is a quarter of a megabyte of raw upstream bodies that never needs to reach a
browser.

---

## Why a grant and a revoke both write the content again

Patching an ACT grantee list produces a *new* history. The bytes already on Swarm stay
attached to the old one and stay readable by the old list; only content written under the
new history reflects the change. So both operations patch and then reseal, and the
payload is fetched back from Swarm as the publisher rather than round-tripped through the
browser.

This is also why revocation here is honestly **forward-only**. A reader who already
downloaded a version keeps it, and can still fetch that version by supplying the timestamp
they were granted at. Page 07 says this in as many words. A reference system that claimed
otherwise would be lying.

---

## The negative control

Page 09 presents a forgery next to the real thing: the same reference, the same dates, the
same machine-readable zone, all five check digits intact — and one claim flipped.

It fails, and it fails for a reason nobody can argue with. The claim set is hashed with
the same canonical encoder the issuer used, and the resulting commitment is put to
`ZegelAnchor.verify()` on Base mainnet, which answers `commitment-mismatch`. Nobody
recognised the forgery; the sum simply does not come out.

Check digits, by contrast, prove only that the line was printed correctly. A forger gets
the 7-3-1 weights right without effort. The desk says so on the page.

---

## The machine-readable zone

A real ICAO 9303 TD3 zone: two lines of forty-four characters with the genuine 7-3-1
weighted check digits, recomputed at the desk from the line as printed.

Every field is filled from something the envelope already publishes:

```
PZ ENS <name>                                     document code, issuing namespace, holder
ZGL<6 hex of the reference id>                    document number
<window start, YYMMDD>                            "record begins", where a passport puts a birth date
<                                                 the sex field, left as filler
<expiry, YYMMDD>
T<tier><12 hex of the commitment>                 the optional-data field
```

The issuing authority is `ENS`, not a country: the thing that issued this identity is a
name registry. The sex field stays filler because a reference makes assertions about a
record, never about a person. And the wallet does not appear anywhere in the zone.
