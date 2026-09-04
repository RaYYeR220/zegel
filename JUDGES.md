# Verify this in five minutes

A booth, a laptop, no preparation. Steps 1–6 need **nothing but `curl` and a browser** — no
wallet, no API key, no funded account, nothing installed. Steps 7–12 need `pnpm install` and
nothing else. Part B, at the end, lists the two things that genuinely need more, and says exactly
what and why.

Every command below was run on 2026-09-04 and produced the output shown. Full evidence chain in
[PROOF.md](./PROOF.md); the claim-by-claim ledger, including what we do **not** assert, is in
[CLAIMS.md](./CLAIMS.md).

---

# Part A — zero credentials

## 1. Make the chain say "no" (30 seconds, curl only)

This is the one to do first. A verification that cannot fail is not a verification.

**Green** — `ZegelAnchor` on Base mainnet, asked about a real reference with its real commitment:

```bash
curl -s https://mainnet.base.org -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"eth_call","params":[{"to":"0xbcB85eCdeF23a11D5015b260cC4eDCc0c250f42e","data":"0x4e8fee00a5a4d829143280bd2ad24c33c9f94da4e37cf6d5d29ba1acef4c9b2a96f51a9fce99fc040a03fb82d617b61fce60933590049b003b7b5b989f7c3681f1b3fca5"},"latest"]}'
```

> `{"jsonrpc":"2.0","result":"0x00…01","id":1}` — **1, Valid**

**Red** — the same call with the last hex digit of the commitment changed from `5` to `6`:

```bash
curl -s https://mainnet.base.org -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"eth_call","params":[{"to":"0xbcB85eCdeF23a11D5015b260cC4eDCc0c250f42e","data":"0x4e8fee00a5a4d829143280bd2ad24c33c9f94da4e37cf6d5d29ba1acef4c9b2a96f51a9fce99fc040a03fb82d617b61fce60933590049b003b7b5b989f7c3681f1b3fca6"},"latest"]}'
```

> `"result":"0x00…04"` — **4, CommitmentMismatch**

**Proves:** the commitment is anchored on a public chain and one altered character breaks it. The
verdict comes from Base, not from any Zegel code, and anyone can repeat the `eth_call`.
`0x4e8fee00` is `verify(bytes32,bytes32)`.

Contract: https://basescan.org/address/0xbcB85eCdeF23a11D5015b260cC4eDCc0c250f42e

## 2. Read the access-control argument straight off mainnet (30 seconds)

```bash
curl -s https://ethereum-rpc.publicnode.com -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"eth_call","params":[{"to":"0x479b0E18B3cE76C62402622e654bc235B1B529d1","data":"0xecbfada316a79596bc3e4f83503f87e3113fbf0ab994d16627eefff4ab039e46651cd7e7000000000000000000000000000000000000000000000000000000000000004000000000000000000000000000000000000000000000000000000000000000117a6567656c2e656e76656c6f70652e7631000000000000000000000000000000"},"latest"]}'
```

> `"error":{"code":3,"message":"execution reverted","data":"0x556f1830…"}`

`0x556f1830` is ERC-3668's `OffchainLookup`. Decode it:

```bash
cast decode-error --sig "OffchainLookup(address,string[],bytes,bytes4,bytes)" 0x556f1830…
```

```
sender            0x479b0E18B3cE76C62402622e654bc235B1B529d1   <- the RESOLVER, not the caller
urls              ["https://zegel-gateway.vercel.app/v1/{sender}/{data}"]
callbackFunction  0xf4d4d2f8                                    <- resolveWithProof
```

**Proves:** a CCIP-Read gateway is never told who is reading — only which resolver asked. That is
why Zegel's gateway holds nothing secret and the confidentiality lives in Swarm ACT instead. If
the callback authenticated a *signer* — the only design that works — every gateway response would
be a freely replayable bearer token until it expires.

## 3. Complete the ERC-3668 round trip by hand (1 minute)

Take the `urls` and `callData` from step 2, substitute, fetch:

```bash
curl -s "https://zegel-gateway.vercel.app/v1/0x479b0E18B3cE76C62402622e654bc235B1B529d1/0xecbfada316a79596bc3e4f83503f87e3113fbf0ab994d16627eefff4ab039e46651cd7e7000000000000000000000000000000000000000000000000000000000000004000000000000000000000000000000000000000000000000000000000000000117a6567656c2e656e76656c6f70652e7631000000000000000000000000000000"
```

> `{"data":"0x0000…"}` — `abi.encode(bytes result, uint64 expires, bytes signature)`

Feed it back to the contract through `resolveWithProof(bytes,bytes)` with the `extraData` from
step 2, and the on-chain callback verifies the signature and returns the envelope as UTF-8 JSON:

```json
{"anchors":{"base":{"chainId":8453,"contract":"0xbcB85eCdeF23a11D5015b260cC4eDCc0c250f42e", …}},
 "commitment":"0xce99fc040a03fb82d617b61fce60933590049b003b7b5b989f7c3681f1b3fca5",
 "referenceId":"0xa5a4d829143280bd2ad24c33c9f94da4e37cf6d5d29ba1acef4c9b2a96f51a9f",
 "tiers":[{"tier":1,"swarmRef":"455c6296…","actPublisher":"02ccb978…","actHistoryAddress":"51c29bff…"},
          {"tier":2,"swarmRef":"056a12d3…", …}]}
```

**Proves:** `zegel.eth` resolves through a real ENS resolver on Ethereum mainnet, over ERC-3668,
under ENSIP-24 `data()`, and the on-chain callback — not the client — is what accepts the
response. Measured today: gateway leg 1,765 ms cold, callback leg 210 ms.

Prefer a library? Step 8 does the same thing through viem in one command.

## 4. Check the gateway against the source it relays (30 seconds)

The gateway is a relay over a Swarm feed whose topic is public — `keccak256(utf8(dataKey) ‖ node)`.
Read the feed yourself, from a public Swarm gateway, and compare:

```bash
curl -s https://api.gateway.ethswarm.org/feeds/2aF75dAb9634c389c5aAdDa4D74fcdc944c83218/44929537419c8793bbd340f367bb896ef229032630b19b8f949152e9d23a2d11
```

> 1,062 bytes — byte-identical to what step 3 returned.

**Proves:** the gateway operator can censor but cannot substitute. A relay you can audit is worth
more than one you have to trust. It also proves the public part carries **no wallet address**:
grep the output for one.

## 5. Read the Solana attestation (30 seconds)

```bash
curl -s https://api.mainnet-beta.solana.com -H 'content-type: application/json' \
 -d '{"jsonrpc":"2.0","id":1,"method":"getAccountInfo","params":["36A3Fyeid2fauHVs1atAvc8YFvt7tvDSMqofZaeYYQbM",{"encoding":"base64"}]}'
```

Base64-decode the data and search the hex for `ce99fc040a03fb82d617b61fce60933590049b003b7b5b989f7c3681f1b3fca5`.
It is there — the same commitment as Base and as the ENS envelope, in a third place.

Or open it: https://solscan.io/account/36A3Fyeid2fauHVs1atAvc8YFvt7tvDSMqofZaeYYQbM

Then look at the mint, https://solscan.io/account/4q5SUtLBMRZztPTHdHK3QdDCjyPoezUiKpBdTpvvjtFq —
`nonTransferable`, `permanentDelegate` and `mintCloseAuthority` both the SAS program PDA,
supply 1. **Soulbound by construction:** the program can burn and close it, the subject cannot
move it away from where a verifier looks.

## 6. Open the app (1 minute, browser)

**https://zegel-app.vercel.app**

| Page | What it shows |
|---|---|
| `/` | The dossier the surveillance industry already has, built live from Mobula. Type any address or ENS name. No wallet, no key. |
| `/verify` | The recipient's desk. Resolve `zegel.eth`, read the anchor off Base. |
| `/access` | Who may read what — grant, read, revoke. Needs Bee nodes (Part B). |
| `/issue` | Needs a browser wallet, and that is the point (Part B). |

Health strip at the foot of every page: each pill is a request made in that moment, with its
latency. https://zegel-gateway.vercel.app/health is the same idea for the gateway, including its
own on-chain cross-check that the resolver really allowlists its signing key.

---

## Install once

Every package installs and tests standalone. From the repo root:

```bash
cd cli && pnpm install          # ~20 s
```

> Tests are run **per package**, each after `pnpm install` in its own directory. A recursive
> `pnpm -r test` from the root covers six of the seven workspace projects and misses `cli` and
> `contracts` entirely, so it reports 404 of the 702 — see step 12.

## 7. `zegel doctor` — every dependency, probed live (5 seconds)

```bash
node bin/zegel.mjs doctor
```

```
Mobula demo host (no key, no signup)     ✓ works        425 ms  HTTP 200
Mobula GraphQL (open, unauthenticated)   ✓ works        254 ms  HTTP 200
Mobula production host (MOBULA_API_KEY)  - not set up        —  MOBULA_API_KEY is not set …
Swarm public gateway (nodeless sealing)  ✓ works        619 ms  HTTP 200 OK
Local Bee node (grant / revoke)          ✓ works         44 ms  ACT publisher 02ccb978ca…
Ethereum RPC (ENS resolution)            ✓ works        203 ms  eth_chainId 0x1
Base RPC (reachable at all)              ✓ works        264 ms  eth_chainId 0x2105
ZegelAnchor on Base (revocation check)   ✓ works        437 ms  verify() returned 1 (valid)

✓ The zero-credential path is available: scan and issue will run.
```

**Proves:** four states, not two — `works`, `degraded`, `unavailable`, `not set up`. "You have not
configured this" is never painted the same red as "this is broken", and every row prints the URL
it contacted so you can repeat it. Without a Bee node the fifth row reads `not set up` and the
verdict still says the zero-credential path is available. Exit 0.

## 8. Green, then red, against mainnet — from the CLI (20 seconds)

Two envelopes ship in `cli/fixtures/`. They address a reference genuinely anchored on Base and
**differ by exactly one hex digit of the commitment.**

```bash
node bin/zegel.mjs verify fixtures/anchored-reference.json;          echo "exit $?"
node bin/zegel.mjs verify fixtures/anchored-reference-tampered.json; echo "exit $?"
```

```
✓ VALID  Valid.
  ✓ on-chain anchor    valid at 0xbcB85eCdeF23a11D5015b260cC4eDCc0c250f42e
exit 0

✗ TAMPERED  These are not the claims that were sealed.
  That answer came from the chain, not from this tool: anyone can repeat the
  call and get the same number.
  ✗ on-chain anchor    commitment-mismatch at 0xbcB85eCdeF23a11D5015b260cC4eDCc0c250f42e
exit 4
```

Then the live name, resolved through mainnet CCIP-Read by stock viem with no special
configuration:

```bash
node bin/zegel.mjs verify zegel.eth
```

```
read from    ENS zegel.eth via https://ethereum-rpc.publicnode.com
reference id 0xa5a4d829143280bd2ad24c33c9f94da4e37cf6d5d29ba1acef4c9b2a96f51a9f
commitment   0xce99fc040a03fb82d617b61fce60933590049b003b7b5b989f7c3681f1b3fca5
TIER  SWARM REFERENCE      ACT HISTORY ADDRESS  ACT PUBLISHER
1     455c6296d5c8…d3337b  51c29bff05cb…c597fe  02ccb978ca89…799d1f
2     056a12d34f7b…b38232  51c29bff05cb…c597fe  02ccb978ca89…799d1f
✓ VALID
```

**Proves:** the whole chain — ENS name → resolver → gateway → Swarm feed → envelope → anchor on
Base — with no mocks anywhere in the path.

## 9. See why the product exists (30 seconds)

```bash
node bin/zegel.mjs scan vitalik.eth --out .zegel/bundle.json
```

Realized profit and loss, the worst positions by name, **who funded the wallet first**, the
hour-by-hour trading histogram and the timezone it implies, the DEX routers used, the safety
score of every token traded, and a list of other addresses that appeared in the same
transactions — "a starting point for clustering, which is exactly how deanonymisation begins".

**Proves:** none of this needed the wallet owner's consent, and it does not expire. That is the
default state of a public address.

The last section is titled *what could not be collected* and names each failed upstream with its
HTTP status. `demo-api.mobula.io` rate-limits, so on a given day you may see
`GET /2/token/security  429`. Those are recorded as unavailable rather than filled in, which is
why the same command can yield fewer claims on a different run.

## 10. Watch it refuse to flatter (10 seconds)

```bash
node bin/zegel.mjs issue --bundle .zegel/bundle.json
```

Ten claim specs, derived from the evidence you just collected — each printed with the sentence a
non-crypto reader sees and the threshold it asserts. **Failed claims are printed as prominently
as passed ones**, and a claim no source supports is omitted rather than defaulted to a failure.

How many you get depends on what Mobula answered in step 9. The reference run, which anyone can
reproduce offline from the recorded fixture in `packages/evidence/test/fixtures/bundle-evm.json`,
derives all ten and **four of them fail**: the wallet is a net loser over the window with a 20%
win rate, and 75% of the tokens it traded score below Mobula's 60/100 safety threshold. Zegel
says so.

With no Bee node it seals through the public Swarm gateway and then **refuses to publish the
tiers**, because that gateway never reveals its own ACT publisher key, so no reader could open
them:

```
! 2 of 2 tiers cannot go into the envelope, so the envelope will publish 0 tier(s).
  The claims and the commitment above are real regardless: the commitment is a hash of
  the claim set, not of anything Swarm returned. What is missing is a reader path.
```

**Proves:** the failure mode is a stated omission, not a tier record pointing at something nobody
can read. Writes `.zegel/envelope.json` and `.zegel/claims.json`.

## 11. Break your own claim set (20 seconds — the red one)

```bash
node bin/zegel.mjs verify .zegel/envelope.json; echo "exit $?"
# ✓ VALID   ✓ commitment  recomputed 0x…, and it matches the envelope
# exit 0
```

It finds `claims.json` next to the envelope and says so. Now open `.zegel/claims.json`, find any
claim with `"passed": false`, change it to `true`, save, and run the same command again:

```
✗ TAMPERED  These are not the claims that were sealed.
  ✗ commitment  recomputed 0x…, envelope carries 0x…    (two different hashes)
exit 4
```

Undo the edit and it is `VALID` again.

**Proves:** the commitment is a hash of the claim set, so a claim set edited to flatter its
subject stops matching. Seven verdicts, seven distinct exit codes — `valid` 0, `expired` 2,
`revoked` 3, `tampered` 4, `not-granted` 5, `malformed` 6, `unverifiable` 7. `unverifiable`
exists because rounding "nothing was checkable" up to `valid` would be the one lie this command
cannot afford.

## 12. The tests (2 minutes)

```bash
cd ../contracts && forge test
# 120 tests passed, 0 failed, 0 skipped (4 suites)
```

Then, each from its own directory after `pnpm install` there:

| Package | Result |
|---|---|
| `contracts` | 120 passed |
| `cli` | 178 passed |
| `gateway` | 118 passed, 1 skipped |
| `packages/evidence` | 98 passed, 1 skipped |
| `solana` | 89 passed, 7 skipped (devnet integration, needs a funded devnet keypair) |
| `packages/seal` | 83 passed with a local Bee node; 82 passed / 1 skipped without |
| `packages/sdk` | 16 passed |
| **Total passing** | **702** |

Coverage over `contracts/src`: 99.04% lines, 100.00% functions, 94.92% branches.

**A flake that was here and is now fixed.** `gateway/test/contract.test.ts > is rejected on chain once the response has expired` used to derive its expiry from the host clock. anvil's `block.timestamp` only advances when a block is mined, so a chain sitting a second behind wall time did not consider the response expired and the revert did not fire — it failed roughly one run in four. The expiry is now read from the chain's own latest block, and the test passed five consecutive runs. The contract was never at fault: `ZegelResolver` enforces `if (expires < block.timestamp) revert SignatureExpired(...)`, and `test_RevertWhen_SignatureExpired`, `test_ExpiryBoundaryIsInclusive` and `testFuzz_ExpiryIsEnforced` pin the same boundary deterministically with `vm.warp`.

The gateway suite's `contract.test.ts` is the one worth reading: it compiles `ZegelResolver`,
deploys it to a local anvil, starts the gateway on a real port, writes that port into the
resolver's `gatewayUrls()`, and lets viem drive the full `OffchainLookup` → HTTP →
`resolveWithProof` round trip — then asserts on-chain rejection of a response lifted onto another
name, `extraData` naming the UniversalResolver, an expired response, and a revoked signer.

---

# Part B — the steps that need something

Two things, and only two. Both are refused with a reason rather than simulated when the
prerequisite is absent.

## B1. Grant and revoke — needs a Bee node (two, to show a real grantee)

**Why:** `POST /grantee` is answered with **404** by the public Swarm gateway, so grantee lists
can only be managed on a node you run. And the ACT publisher private key has to be one you hold —
a gateway that holds it will decrypt for anyone presenting the three public coordinates, which is
obscurity, not access control. There is no honest degraded mode, so without a node the command
prints what is missing, why the gateway cannot substitute, and exits non-zero. It never reports a
grant that did not happen.

**Why two nodes:** ACT decryption happens inside Bee with the reader's own key. There is no
browser implementation. An **unfunded ultra-light node is enough** to be a grantee — reading
costs nothing — so the ask is "run one more binary", but it is a real ask.

```bash
bee start --full-node=false                 # publisher, 127.0.0.1:1633, needs postage to seal
bee start --full-node=false --api-addr :1643  # grantee, unfunded, read only
export ZEGEL_BEE_URL=http://127.0.0.1:1633
node bin/zegel.mjs doctor                   # the Bee row turns green, with its ACT publisher key

node bin/zegel.mjs keypair                  # a throwaway grantee identity; copy the public key
node bin/zegel.mjs issue --bundle .zegel/bundle.json --grant <pubkey>
node bin/zegel.mjs grant  <another-pubkey>
node bin/zegel.mjs revoke <pubkey>
```

The transcript this produces, and the one we ran, is in [PROOF.md §6.3](./PROOF.md). The three
rows that matter, reproduced today:

| Read | Result |
|---|---|
| revoked grantee reads the new version | **404** `{"code":404,"message":"act or history entry not found"}` |
| publisher reads the same new version | **200** — so the failure is *access*, not absence |
| revoked grantee reads the version they were already granted | **200** — revocation is forward-only, and we show it |

**The red command, with only curl and a node that holds the ACT keys:**

```bash
# 200 — 994 bytes, the tier-1 claim set
curl -i -H "swarm-act: true" \
  -H "swarm-act-publisher: 02ccb978ca8962cfaaba490b834894480e10be09633bfacfba8853dd4b81799d1f" \
  -H "swarm-act-history-address: 51c29bff05cba8f8b58e8db39e02e9803acdbc34be9125d0eda49b296dc597fe" \
  http://127.0.0.1:1633/bytes/455c6296d5c84827a74be288d3b527f0ebe889246f3a49ac36a50dc78bd3337b

# 404 — drop the three headers, same reference, same second
curl -i http://127.0.0.1:1633/bytes/455c6296d5c84827a74be288d3b527f0ebe889246f3a49ac36a50dc78bd3337b
```

## B2. Issuing for a wallet — needs that wallet's key

**Why:** a reference is an assertion about somebody's money, and the only person who may make it
is the person who can sign for the wallet. `/issue` verifies an EIP-191 signature over
`Zegel reference <id>` and refuses anything else. There is no operator override and no
issue-on-behalf-of path. That is also why every live reference in this repo is for our own
wallet, `0x7C7625c81D933fA006bBd3eE2601C8eA8251a14B`.

A browser wallet on https://zegel-app.vercel.app/issue is enough. Publishing an envelope under an
ENS name additionally needs the feed signing key and postage, which is why it happens on the
issuer's own node and never in the gateway.

## Not needed, at any point

- **A Mobula API key.** `demo-api.mobula.io` needs no key and no signup, and `graphql.mobula.io`
  is open over HTTP. A key raises rate limits and enables WebSocket streaming; nothing else
  changes, and the CLI says so when it is absent rather than quietly polling and calling it live.
- **A funded account on any chain**, to verify. Every check in Part A is an `eth_call`, an RPC
  read or an HTTP GET.
- **A Solana keypair**, to verify. `zegel-sas status` and `zegel-sas verify` never touch one.

---

## The one-line summary for each artifact

| Ask | Command | Answer |
|---|---|---|
| Is it really on mainnet? | step 1 | Base returns `1` |
| Can it go red? | step 1, second command | Base returns `4` |
| Does the name resolve? | `node bin/zegel.mjs verify zegel.eth` | `✓ VALID`, exit 0 |
| Can a verifier be lied to? | step 11 | `✗ TAMPERED`, exit 4 |
| Is the access control real? | B1, second curl | `404` with the bytes demonstrably present |
| Does it flatter its subject? | step 10 | four of ten claims fail on screen |
