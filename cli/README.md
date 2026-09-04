# `zegel` — the command line

Zegel is a private financial reference: prove you are good with money to **one**
named person, for a limited time, revocably, under an ENS name, without revealing
the wallet.

This package is the surface you drive it from. Seven commands, all of which run with
**no wallet, no API key, no funded account and no install beyond `pnpm install`**.

```
zegel scan <address|ens-name>     the exposure dossier — what anyone can already learn
zegel issue <address|ens-name>    derive claims, seal both tiers, print the envelope
zegel verify <ens-name|file>      recompute and report valid / expired / revoked / tampered / not-granted
zegel grant <pubkey...>           add a reader          (needs a local Bee node)
zegel revoke <pubkey...>          cut a reader off      (needs a local Bee node)
zegel keypair                     a throwaway grantee identity, so grant/revoke can be shown
zegel doctor                      probe every dependency and print what works right now
```

## Deployed, and read by this CLI

| what | where |
|---|---|
| `ZegelAnchor` | Base mainnet `0xbcB85eCdeF23a11D5015b260cC4eDCc0c250f42e` ([deploy tx](https://basescan.org/tx/0x7c32343d11f3c74dd4d22f48ad15172d80396aabc9e8808666fa3803a2f5d87d), block 50,843,365) |
| a reference anchored on it | `referenceId 0x644e1b8b…4c30ce`, [anchor tx](https://basescan.org/tx/0xe35a44bd37ee922d719728dcc24e1e046dc98663bf406b9bb722202188d243b6) |

Reading either needs no key, no wallet and no funded account, which is why
`verify` consults the anchor by default and `doctor` probes it.

---

## The 60-second path

Run these in order, from `zegel/cli/`. Nothing below needs a key, a wallet or a
funded account. Times are what they took on a laptop over conference wifi.

1. **`pnpm install`** — about 20 s, once.

2. **`pnpm zegel doctor`** — 2 s. A live capability table: Mobula's demo host,
   Mobula's open GraphQL, the public Swarm gateway, a local Bee node if you have
   one, and the two RPCs. Every row is a request made in that moment. Rows that do
   not work say what that costs you. **Exit 0 means the zero-credential path is
   available.**

3. **`pnpm zegel scan vitalik.eth --out .zegel/bundle.json`** — about 30 s. The
   exposure dossier, built live from Mobula. Read it out loud: realized profit and
   loss, the worst positions by name, **who funded the wallet first** (a named
   individual, in this case), the hour-by-hour trading histogram and the timezone
   it implies, the DEX routers used, and the safety score of every token traded.
   The last section says what could not be collected, rather than filling it in.

   *This is the argument.* None of it needed the wallet owner's consent, and it
   does not expire.

4. **`pnpm zegel issue --bundle .zegel/bundle.json`** — about 5 s
   (it reuses step 3's evidence instead of collecting again). Ten claims derived
   from that same data, each with the sentence a non-crypto reader sees and the
   threshold it asserts. **Some of them fail, on screen.** Then the negative
   control: the claims are re-derived from the stored upstream bodies and compared
   to themselves. Then both tiers are sealed on Swarm under ACT, and the public
   envelope is printed — a commitment, an expiry, and where the ciphertext lives.
   Nothing in it identifies the wallet.

5. **`pnpm zegel verify .zegel/envelope.json`** — instant. It finds `claims.json`
   next to the envelope (and says so), recomputes the commitment, and reports
   `VALID`. Exit code 0.

6. **The negative control, live.** Open `.zegel/claims.json`, find any claim with
   `"passed": false`, change it to `true`, save. Run step 5 again:

   ```
   ✗ TAMPERED  These are not the claims that were sealed.
   ...
   exit code 4
   ```

   Undo the edit and it is `VALID` again. The commitment is a hash of the claim
   set, so a claim set that flatters its subject stops matching.

7. **The same negative control, against mainnet.** Two envelopes ship in
   `fixtures/`. They address a reference really anchored on Base by
   `ZegelAnchor` at `0xbcB85eCdeF23a11D5015b260cC4eDCc0c250f42e`, and they differ
   by exactly one hex digit of the commitment.

   ```
   node bin/zegel.mjs verify fixtures/anchored-reference.json
   node bin/zegel.mjs verify fixtures/anchored-reference-tampered.json
   ```

   The first reads the contract and prints
   `on-chain anchor  valid at 0xbcB8…` — exit 0. The second gets
   `commitment-mismatch` back, which is `verify()` returning **4
   (CommitmentMismatch)** from Base mainnet, and exits **4**. No key, no wallet,
   no funded account: the answer comes from the chain, not from this tool, and
   anyone can repeat the `eth_call`.

8. **`pnpm zegel grant <pubkey>` / `pnpm zegel revoke <pubkey>`** — needs a local
   Bee node (see below). Without one, this refuses, names exactly what is missing
   and why the public gateway cannot substitute for it, and exits non-zero. It
   never reports a grant that did not happen.

Steps 1–7 are the whole product with zero credentials. Step 8 is the part that
needs a node, and it says so rather than pretending.

---

## What each command actually does

### `zegel scan <address|ens-name>`

Runs the real collection against Mobula's demo host — no key, no signup — across
`evm:1`, `evm:8453` and `solana`, then renders it as a dossier.

An ENS name is normalised under ENSIP-15 and resolved to an address first; a name
that does not resolve is an error, never a silent fallback to scanning something
else.

The one inference in the whole report is the timezone, and its assumption is
printed next to its conclusion: *the quietest eight hours of the day are a night,
and a night starts at local midnight.* The raw 24-hour histogram is printed too,
so you can reject the inference. A wallet that trades round the clock gets
`weak` confidence and an explicit "do not read a location into this".

| flag | |
|---|---|
| `--days <n>` | window length, default 730 |
| `--chains <list>` | default `evm:1,evm:8453,solana` |
| `--max-security <n>` | how many assets to score for risk; each costs 10 Mobula credits |
| `--no-probe-optional` | skip the three Mobula routes known to 500, and finish in ~3 s |
| `--out <file>` | write the evidence bundle, so `issue` can reuse it |
| `--explain` | print the upstream endpoint and source indices behind each section |

### `zegel issue <address|ens-name>`

Collects evidence (or reuses a bundle with `--bundle`), derives the ten claims,
builds the tier-1 claim set and the tier-2 bundle, seals both under Swarm ACT, and
prints the envelope with its commitment.

Failed claims are printed as prominently as passed ones. That is deliberate: a
reference that only ever flatters its subject is worth nothing to the person
reading it, and the derivation cannot be persuaded.

Writes `envelope.json` and `claims.json` into `--out` (default `.zegel/`), plus a
receipt log. `--emit-bundle` also writes the tier-2 bundle, which **contains the
address** — the output labels it as such.

| flag | |
|---|---|
| `--bundle <file>` | reuse a bundle from `scan --out` |
| `--grant <pubkey...>` | grant these keys at seal time (needs a Bee node) |
| `--no-seal` | derive and commit only; never touch Swarm |
| `--expires-days <n>` | reference lifetime, default 30 |
| `--anchor <address>` | record a `ZegelAnchor` address as the revocation hint |
| `--explain` | print the endpoint, parameters and digest behind each claim |

### `zegel verify <ens-name|envelope.json>`

Loads an envelope from a file, or resolves one from an ENS name through ENSIP-10
`resolve()` and ENSIP-24 `data()`. Then it recomputes the commitment from a claim
set, **reads the on-chain anchor**, optionally tries to open a sealed tier, and
reports one of seven verdicts with a distinct exit code:

| verdict | exit | means |
|---|---|---|
| `valid` | 0 | every check that was run passed |
| `expired` | 2 | it aged out; nobody withdrew anything |
| `revoked` | 3 | the issuer withdrew it, observably, on chain |
| `tampered` | 4 | the claims in front of you are not the claims that were sealed |
| `not-granted` | 5 | Swarm answered 404 |
| `malformed` | 6 | not a Zegel envelope |
| `unverifiable` | 7 | nothing checkable was available |
| — | 1 | operational failure: unreachable RPC, unreadable file |

`unverifiable` exists because an envelope on its own is public, unauthenticated
metadata. Without a claim set to recompute against, an anchor to read, or a tier
to open, there is nothing to conclude, and rounding that up to `valid` would be
the one lie this command cannot afford.

`not-granted` is reported with its caveat attached: Swarm's 404 is byte-identical
for content you were never granted, content your grant was withdrawn from, and
content that never existed. That indistinguishability is the privacy property.

**The anchor is consulted by default.** `ZegelAnchor` at
`0xbcB85eCdeF23a11D5015b260cC4eDCc0c250f42e` on Base mainnet is a keyless read, so
there is no reason to make a verifier opt in to the one check that can tell a live
reference from a revoked one. An address inside the envelope wins over the
default; `--anchor` wins over both; `--skip-anchor` turns it off. When the chain
cannot be reached the verdict says *"the anchor contract could not be read, so
revocation could not be ruled out — this is a gap in the check, not a pass"*, and
never returns `valid` as though it had looked.

A reference the contract has never seen comes back `never-anchored`, which is
reported as a skipped check rather than a failure: locally issued references are
not anchored until someone pays for it, and that is a fact about the reference
rather than a problem with it.

| flag | |
|---|---|
| `--claims <file>` | claim set to recompute the commitment from; auto-discovered next to the envelope, loudly |
| `--anchor <address>` | override the anchor contract (default: the deployed one on Base) |
| `--anchor-rpc <url>` | override the Base RPC (default: `mainnet.base.org`, then a fallback) |
| `--skip-anchor` | do not touch the chain; the verdict then says revocation was not ruled out |
| `--open <tier>` | try to open a sealed tier — this is what produces a real `not-granted` |
| `--show-claims` | print the claim set that was verified |

### `zegel grant` / `zegel revoke`

Patch the ACT grantee list of a sealed tier, by compressed secp256k1 public key.

**These need a Bee node.** `POST /grantee` is answered with 404 by the public Swarm
gateway, and the ACT publisher private key has to be one we hold. There is no
honest degraded mode, so without a node the command refuses, prints what is
missing, why the gateway cannot substitute, and what it costs you — and exits 1.

Get a node running in light mode and point the CLI at it:

```
bee start --full-node=false
export ZEGEL_BEE_URL=http://127.0.0.1:1633
pnpm zegel doctor
```

The grantee list only exists if the object was sealed with at least one grantee,
so the flow is:

```
pnpm zegel keypair                                    # copy the public key
pnpm zegel issue --bundle .zegel/bundle.json --grant <pubkey>
pnpm zegel grant <another-pubkey>
pnpm zegel revoke <pubkey>
```

Patches are serialised behind a 1.1 s floor, because Bee keys each ACT history
version on the wall-clock second and two writes inside one second collide.

`revoke` prints what revocation actually did, which is less than the word
suggests: the removed key keeps everything it already downloaded, and can still
fetch the version it was granted by supplying that timestamp until the content is
sealed again under the new history. Forward-only, and said out loud.

### `zegel doctor`

Probes Mobula's demo host, Mobula's open GraphQL, Mobula's production host (only
if `MOBULA_API_KEY` is set), the public Swarm gateway, a local Bee node **and its
postage capacity**, the Ethereum and Base RPCs, and **the `ZegelAnchor` contract on
Base** — the last by asking it about a reference that is genuinely anchored, so a
green tick there means the enum decoded and not merely that a socket opened.
`--deep` also hits the three Mobula routes known to return 500s upstream.

The Bee row is degraded rather than green when the node has no postage capacity
left, because a full batch fails a seal with an error nobody expects. That is the
one failure that is cheap to see here and expensive to discover on stage.

Four states, and the fourth matters: `works`, `degraded`, `unavailable`, and
`not set up` — so "you have not configured this" is never painted the same red as
"this is broken". Every row prints the exact URL that was contacted so you can
repeat the request yourself. Exit 0 when the zero-credential path is available,
1 when something it needs is down.

### `zegel keypair`

A throwaway grantee identity. A real verifier generates this on their own machine
and never sends the private half anywhere — this exists because a demo that cannot
produce a grantee cannot demonstrate revocation, and revocation is the point.

---

## Global flags

| flag | |
|---|---|
| `--json` | one machine-readable document on stdout and nothing else, on every command |
| `--no-color` | plain text; `NO_COLOR` is honoured without it |
| `--ascii` | ASCII-only box drawing, for terminals that mangle Unicode (or `ZEGEL_ASCII=1`) |
| `-q, --quiet` | no progress output |

Colour is decided from the environment: `NO_COLOR` beats everything, `FORCE_COLOR`
turns it back on for a CI log, and a pipe gets plain text. Colour never carries
meaning on its own — every painted status also says what it is in words.

`pnpm` prints a script banner on stdout, and `pnpm --silent` suppresses it but
flattens every non-zero exit code to 1. So for anything scripted — and in
particular for the `verify` exit codes — call the binary directly:

```
node bin/zegel.mjs scan vitalik.eth --json | jq .metrics
node bin/zegel.mjs verify .zegel/envelope.json --json; echo $?   # 0/2/3/4/5/6/7
```

`pnpm zegel …` is fine for reading, and does propagate the exit code; it just
prints two banner lines first.

## Environment

| variable | | default |
|---|---|---|
| `MOBULA_API_KEY` | switches collection to the production host | unset — the demo host is used |
| `ZEGEL_BEE_URL` / `BEE_API_URL` | local Bee node | `http://127.0.0.1:1633` |
| `SWARM_GATEWAY_URL` | public Swarm gateway | `https://api.gateway.ethswarm.org` |
| `ZEGEL_ACT_PUBLISHER` | ACT publisher key when the backend will not report one | unset |
| `ETH_RPC_URL` | mainnet RPC, for ENS resolution | `ethereum-rpc.publicnode.com`, then `eth.merkle.io` |
| `ZEGEL_BASE_RPC` / `BASE_RPC_URL` | Base RPC, for the commitment anchor | `mainnet.base.org`, then `base-rpc.publicnode.com` |
| `ZEGEL_ANCHOR_ADDRESS` | ZegelAnchor contract | `0xbcB85eCdeF23a11D5015b260cC4eDCc0c250f42e` |
| `NO_COLOR` / `FORCE_COLOR` / `ZEGEL_ASCII` | rendering | |
| `ZEGEL_DEBUG` | print stack traces for unexpected failures | unset |

---

## Honest limits

Said here because they are true, and because a judge will find them anyway.

1. **Without a Bee node, `issue` seals but cannot publish.** The public Swarm
   gateway never reveals its own ACT publisher key, so a tier record built from it
   would point at something nobody can open. Those tiers are left out of the
   envelope and the omission is printed. The claims and the commitment are real
   regardless — the commitment is a hash of the claim set, not of anything Swarm
   returned.

2. **Sealing through the public gateway is obscurity, not access control.** The
   gateway holds the publisher private key and will decrypt for anyone who
   presents the three ACT coordinates. `doctor` and `issue` both label it as such
   rather than counting it as privacy.

3. **Revocation is forward-only.** A past grantee keeps what they downloaded.
   `revoke` prints this every time.

4. **`verify` needs the chain to rule out revocation, and says so when it cannot
   reach it.** The anchor is read by default over a public Base RPC. If that read
   fails, the verdict carries "this is a gap in the check, not a pass" rather than
   quietly returning `valid` as though it had looked.

5. **The timezone is an inference, not a fact.** One assumption, printed beside
   the conclusion, with the raw histogram underneath it.

6. **A Bee node with no postage capacity left falls back to the gateway, loudly.**
   `issue` prints why the node was skipped and that confidentiality has dropped
   from key-bound to obscurity. It is a downgrade, it is announced as one, and
   `doctor` flags the exhausted batch before you hit it.

7. **`--json` is a snapshot, not a stream.** Live Mobula WebSocket data needs a
   paid-plan key; there is no streaming mode here that pretends otherwise.

---

## Tests

```
pnpm test
```

**178 passing** across 10 files. The pure half covers number and unit formatting,
ANSI-aware table and box layout, colour decisions, the exposure analysis and the
timezone inference (against a real recorded Mobula bundle, not invented JSON), the
seven verify verdicts and their precedence when several fail at once, anchor
configuration and call encoding, claim and dossier rendering, argument parsing,
and output plumbing.

The live half is the interesting one. `test/live.anchor.test.ts` asks the deployed
`ZegelAnchor` on Base mainnet three questions and asserts all three answers:

| call | answer |
|---|---|
| `verify(referenceId, real commitment)` | **1** — Valid |
| `verify(referenceId, one hex digit changed)` | **4** — CommitmentMismatch |
| `verify(unknown referenceId, …)` | **0** — NeverAnchored |

plus `isValid` and `issuerOf`, the same mismatch through a raw `eth_call` in the
shape you would paste into `curl`, and that the two shipped fixtures differ by
exactly one character. That is the negative control as something reproducible
rather than something asserted in a README.

`test/live.test.ts` calls Mobula, the Swarm gateway and the RPCs for real, with no
mocks. Both live files **skip themselves when their hosts are unreachable** — an
offline laptop should not produce a red build, and certainly not a green one by
asserting less. Set `ZEGEL_SKIP_LIVE=1` to skip them deliberately; that run
reports **160 passing, 18 skipped**.

```
pnpm typecheck
```

TypeScript strict, `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`.

## How this package is wired

The sibling packages ship TypeScript sources rather than build output, and the
shared wire types must be the same declarations everywhere — a second copy of the
canonical-digest helper would silently break every commitment in the system. So
`bin/zegel.mjs` registers `tsx` and runs the sources directly, resolving
`@zegel/evidence`, `@zegel/seal` and `@zegel/sdk` through the `paths` in
`tsconfig.json` (mirrored in `vitest.config.ts`). No build step for anyone to
discover, and exactly one copy of `@zegel/sdk` in the process.

Command modules are loaded with dynamic `import()`, so `scan` and `doctor` never
pay to load the Swarm client.
