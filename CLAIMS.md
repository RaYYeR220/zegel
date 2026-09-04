# CLAIMS

Every public claim Zegel makes, tagged with what kind of evidence stands behind it. An
unsupported sentence costs more than a missing one, so where the evidence is thinner than the
sentence, the sentence is cut down rather than the evidence stretched.

## The tiers

| Tag | Meaning |
|---|---|
| **REPRODUCIBLE** | You can re-run it right now, from this repo or with `curl`, and get the same answer. The proof is a command, not a record. |
| **VERIFIED-LIVE** | We ran it against production and the artifact is on a public chain or a public host. You can read the artifact; re-running the *write* would cost money or need our keys. |
| **MODELED** | A calculation. Every input is named, and each input is itself tagged. |
| **NOT-CLAIMED** | Something a reader might reasonably assume that we are **not** asserting. |

Line items link to [PROOF.md](./PROOF.md) sections. Commands are in [JUDGES.md](./JUDGES.md).

---

## The real-versus-simulated line

Drawn precisely, because this is the question a security judge asks first.

### Live, in production, no test doubles anywhere in the path

- **Ethereum mainnet.** `zegel.eth`, registered and owned. `ZegelResolver` deployed and set as
  the name's resolver. Every interface read in PROOF.md §3.2 is a live `eth_call`.
- **Base mainnet.** `ZegelAnchor` deployed. Two references anchored, both reading `Valid`.
- **Solana mainnet.** SAS credential, schema, tokenized attestation, mint and subject token
  account, all live and not revoked.
- **Gnosis mainnet.** Two Swarm postage batches bought with real xBZZ.
- **Sepolia.** `ZegelIssuerRegistry` deployed against the current ENSv2 contracts; register,
  grant, revoke and version bump all executed.
- **Swarm.** Real ACT-sealed objects on real postage, published through a real feed, granted to
  and revoked from a second real Bee node.
- **Mobula.** Every claim in every reference is derived from responses fetched live from
  `demo-api.mobula.io`, kept verbatim with their digests.
- **The gateway and the app** are deployed and serving.

### Test doubles, and exactly where they are

- **`gateway/test/contract.test.ts`** deploys `ZegelResolver` to a **local anvil**, not to a
  fork or a mock. The contract is real, the gateway process is real, the HTTP is real and viem
  drives the round trip. What is local is the chain.
- **`packages/evidence/test/fixtures/*.json`** are **recorded** Mobula responses — captured from
  the demo host on 2026-09-03, not invented JSON. Unit tests derive from them so the suite is
  deterministic and runs offline. `test/live.test.ts` calls the real hosts and skips itself when
  they are unreachable.
- **`solana/test/devnet.integration.test.ts`** (7 tests) is **skipped** without a funded devnet
  keypair. `devnet.read.test.ts` and `mainnet.read.test.ts` do real reads.
- **`cli/test/live.test.ts` and `live.anchor.test.ts`** hit Mobula, Swarm, the RPCs and the
  deployed anchor for real, and skip themselves when a host is down.
- **The ten-claim output quoted in demos** (net −$12,526.91, 20% win rate, 75% risk-quality
  ratio) is re-derived from the recorded vitalik.eth fixture, offline. It is reproducible on any
  machine. It is *not* a live scan, and the live scan of the same wallet will differ as the
  window moves.

### Nothing is simulated

There is no mock chain in a demo path, no fake Swarm, no canned Mobula response served as
though it were fresh, and no "grant" that prints success without a `PATCH /grantee`. Where a
capability is missing, the command refuses and names what is missing — see the `doctor` output
and the `issue`-without-a-node transcript in JUDGES.md steps 7 and 10.

---

## A. On-chain deployment and state

| # | Claim | Tier | Proof |
|---|---|---|---|
| A1 | `zegel.eth` is registered on Ethereum mainnet and owned by `0x7C7625c8…51a14B` | VERIFIED-LIVE | [register tx](https://etherscan.io/tx/0xef1d1d55928b1125f72e6c6540870ae62dc38b3a7fa7b69f61b6dff7828ce164), block 25,899,886 · §3.1 |
| A2 | `ZegelResolver` is deployed at `0x479b0E18…B529d1` and is the resolver for `zegel.eth` | REPRODUCIBLE | `cast call 0x0000…2e1e "resolver(bytes32)(address)"` · §3.2 |
| A3 | `ZegelAnchor` is deployed at `0xbcB85eCd…50f42e` on Base mainnet with 2,674 bytes of runtime code, no owner and no constructor arguments | REPRODUCIBLE | `cast code` · [deploy tx](https://basescan.org/tx/0x7c32343d11f3c74dd4d22f48ad15172d80396aabc9e8808666fa3803a2f5d87d) · §4 |
| A4 | The current reference is anchored and reads `1 (Valid)` on Base | REPRODUCIBLE | `eth_call`, JUDGES step 1 · §1.1 |
| A5 | A second, superseded reference is also anchored and still reads `Valid` | REPRODUCIBLE | [anchor tx](https://basescan.org/tx/0xe35a44bd37ee922d719728dcc24e1e046dc98663bf406b9bb722202188d243b6) · §2 |
| A6 | A Solana Attestation Service attestation carries the same commitment and is not revoked | REPRODUCIBLE | `getAccountInfo` on [`36A3Fyei…YYQbM`](https://solscan.io/account/36A3Fyeid2fauHVs1atAvc8YFvt7tvDSMqofZaeYYQbM) · §5 |
| A7 | The attestation is soulbound: `nonTransferable`, `permanentDelegate` and `mintCloseAuthority` all the SAS program PDA, supply 1 | REPRODUCIBLE | `getAccountInfo … jsonParsed` on the [mint](https://solscan.io/account/4q5SUtLBMRZztPTHdHK3QdDCjyPoezUiKpBdTpvvjtFq) · §5 |
| A8 | Two Swarm postage batches were bought on Gnosis mainnet, depth 17 and depth 19 | REPRODUCIBLE | `BatchCreated` topic and data on [tx1](https://gnosisscan.io/tx/0x929fd732a307c5fdd0f0c9a4df6484eff4c8f19e45c05df730b248f64cce5823) / [tx2](https://gnosisscan.io/tx/0xebc001046579fbed46e4b81c9ff421bb68370ba5c33349491635a2c7b3facae9) · §6.1 |
| A9 | `ZegelIssuerRegistry` is deployed on Sepolia and answers `IRegistry` (`0x51f67f40`) and EAC (`0x8f452d62`) | REPRODUCIBLE | `cast call … supportsInterface` · §8 |
| A10 | The batch price was read live from `GET /chainstate` rather than hardcoded | VERIFIED-LIVE | recorded `currentPrice: 84049` at purchase; the code path is in `@zegel/seal` · §6.1 |

## B. What the anchor and the commitment actually prove

| # | Claim | Tier | Proof |
|---|---|---|---|
| B1 | The commitment is `sha256` over the canonical JSON encoding of the tier-1 claim set | REPRODUCIBLE | re-hash the 994 bytes read back through ACT → `0xce99fc04…fca5` · §7.3 |
| B2 | Changing one hex digit of the commitment makes the Base anchor answer `4 (CommitmentMismatch)` | REPRODUCIBLE | JUDGES step 1 · §1.1 |
| B3 | Changing one hex digit makes the Solana verifier answer `COMMITMENT-MISMATCH` and exit 2 | REPRODUCIBLE | JUDGES/PROOF §1.2 |
| B4 | Editing a claim's `passed` from `false` to `true` makes `zegel verify` answer `TAMPERED` and exit 4 | REPRODUCIBLE | JUDGES step 11 |
| B5 | Editing one byte inside a recorded upstream body makes `verifyClaims` fail on that source's digest | REPRODUCIBLE | §1.4 |
| B6 | Revocation on `ZegelAnchor` is a one-way door — `anchor` refuses to touch a revoked id | REPRODUCIBLE | `forge test`, `invariant_RevokedNeverReturnsToValid`, 256 runs × 64 calls, with an `afterInvariant` assertion that a revoked reference was actually reached |
| B7 | Lifecycle outranks content: a revoked reference reads `Revoked` even when the caller also brought the wrong commitment | REPRODUCIBLE | `test_Verify_RevocationOutranksMismatch` |
| B8 | Squatting an unclaimed reference id is possible and harmless | REPRODUCIBLE | `test_SquattingAnIdProducesAMismatch`; stated in `contracts/README.md` |

## C. Access control

| # | Claim | Tier | Proof |
|---|---|---|---|
| C1 | An un-granted read of a sealed tier returns HTTP 404 identical to content that never existed | REPRODUCIBLE | `curl` with and without the ACT headers, §1.3 |
| C2 | The publisher reads the same reference as 200 in the same second, so the failure is access and not absence | REPRODUCIBLE | §1.3 |
| C3 | A separate, unfunded Bee node that holds a granted key reads the sealed object as 200 | VERIFIED-LIVE | grantee node `03c2694c…14cea`, §6.3 |
| C4 | After revocation, that node gets 404 on the next version while the publisher gets 200 | VERIFIED-LIVE | §6.3, re-run 2026-09-04 |
| C5 | After revocation, that node still reads the version it was already granted | VERIFIED-LIVE | §6.3 — **this is the honest limit, demonstrated rather than described** |
| C6 | A CCIP-Read gateway cannot authenticate its caller | REPRODUCIBLE | decode the live `OffchainLookup`: `sender` is the resolver. JUDGES step 2 · §3.3 |
| C7 | The gateway can censor but cannot read or forge | REPRODUCIBLE for "cannot forge" — the envelope is checkable against the feed (§7.1) and the commitment against the anchor. VERIFIED-LIVE for "cannot read" — it holds no ACT key; `/health` reports the keys it does hold | §10, `gateway/README.md` |
| C8 | ACT grantee patches collide inside one wall-clock second and are serialised behind a 1.1 s floor | VERIFIED-LIVE | observed against Bee 2.8.2; the debounce is in `@zegel/seal` |
| C9 | One `bumpEacVersion` write invalidates every prior grant on an ENSv2 name without enumerating anyone | REPRODUCIBLE | `hasRoles` at the granted resource reads `false` live; both node values reproduce offline with `cast keccak` · §8 |
| C10 | A delegate can be scoped to exactly one record on exactly one name | REPRODUCIBLE | decoded calldata: `ROLE_SET_DATA` at `resource(node, dataPart("zegel.envelope.v1"))` · §8 |

## D. Evidence and derivation

| # | Claim | Tier | Proof |
|---|---|---|---|
| D1 | Claims are derived from live chain data, never declared by the subject | REPRODUCIBLE | `deriveClaims` is a pure function of the bundle; thresholds are fixed module constants, not caller options |
| D2 | The derivation is deterministic — same bundle, byte-identical claims on any machine | REPRODUCIBLE | reads no clock, no network, no environment; `pnpm test` in `packages/evidence` |
| D3 | The rules are pinned by `DERIVATION_ID` `0xcd0528ad…415fa`, and a bundle scored by other rules is rejected rather than re-scored | REPRODUCIBLE | `verifyClaims` compares `bundle.derivationId` to the build's constant · §7.5 |
| D4 | The tier-1 claim set contains no measured values and no wallet address | REPRODUCIBLE | grep the 994 bytes read back through ACT: no `"actual"`, no address · §7.4 |
| D5 | An upstream that fails is recorded as `unavailable` with its status and no body, and every claim depending on it is omitted | REPRODUCIBLE | live bundle: source 10, `GET /2/wallet/defi-positions`, HTTP 500, zero claims derived from it · §7.5 |
| D6 | The published reference asserts only 3 of 10 possible claims because the subject wallet was one day old | VERIFIED-LIVE | tier 1 as published carries exactly three claims · §7.4 |
| D7 | Zegel reports unflattering results: 4 of 10 claims fail for the vitalik.eth fixture, including a 20% win rate and a 0.75 risk-quality ratio | REPRODUCIBLE | re-derive from `packages/evidence/test/fixtures/bundle-evm.json` · §7.6 |
| D8 | A tier-2 grantee can re-run the derivation themselves rather than trusting the issuer | REPRODUCIBLE | `verifyClaims` on the tier-2 bundle read back through ACT: ok, 0 mismatches · §7.5 |
| D9 | Mobula's security check hard-kills WETH on Base to `securityScore: 0` | REPRODUCIBLE | `curl -s "https://demo-api.mobula.io/api/2/token/security?address=0x4200000000000000000000000000000000000006&chainId=evm:8453"` → `securityScore: 0`, `killReason: "HARD_KILL:BUNDLER_SUPPLY"`, `"Bundler holdings 56.89% > 40% threshold"`. Reported verbatim, not second-guessed. The recorded fixture carries the same shape for USDT on Ethereum: score 0, `HARD_KILL:BALANCE_MUTABLE` |
| D10 | The timezone in the exposure dossier is an inference, printed next to its assumption, with the raw 24-hour histogram underneath | REPRODUCIBLE | `zegel scan`, JUDGES step 9 |
| D11 | Live WebSocket streaming needs a paid Mobula plan; without one the client polls and says so verbatim | VERIFIED-LIVE | `openPositionsStream()` returns the mode string; `doctor` reports the production host as `not set up` |

## E. Standards

| # | Claim | Tier | Proof |
|---|---|---|---|
| E1 | The resolver implements ENSIP-10 (`0x9061b923`), ENSIP-24 `data()` (`0xecbfada3`) and ERC-7996 (`0x582de3e7`) | REPRODUCIBLE | three live `supportsInterface` calls · §3.2 |
| E2 | The mainnet `PublicResolver` supports neither `0xecbfada3` nor `0x9061b923` | REPRODUCIBLE | live `supportsInterface` on `0xF2910098…04AC15` · §3.2 |
| E3 | The live `ETHRegistrarController` takes a struct, and the eight-positional-argument signature every tutorial shows is absent from its deployed bytecode | REPRODUCIBLE | the registration used selector `0xef9c8805`; `0x74694a2b` does not appear in `cast code` output · §3.1 |
| E4 | `reverseRecord` is a `uint8` bitmask, not a `bool` | REPRODUCIBLE | decode the register calldata against the struct signature · §3.1 |
| E5 | The full ERC-3668 round trip works through stock viem with no special configuration | REPRODUCIBLE | `node bin/zegel.mjs verify zegel.eth` · JUDGES step 8 |
| E6 | `FEATURE_SEALED_ENVELOPE` (`0x13b2642c`) is namespaced to us rather than borrowed, because ENSIP-22 is a draft that reserves no third-party feature ids | VERIFIED-LIVE | stated in `contracts/README.md`; the id reads `true` on chain |
| E7 | The deployed ENSv2 registries answer `supportsInterface(0x8f452d62)` with `true`, and `ZegelIssuerRegistry` uses that on-chain value as a constant (`EAC_INTERFACE_ID`) rather than recomputing it | REPRODUCIBLE | live `supportsInterface` on `ETHRegistry` and on ours · §8. The reason for the constant is that the id computed from the member list published in the ENSv2 docs does not reproduce it — the live interface evidently has members beyond the documented set. **We do not claim to know the full live member list**, and the contract says so in a comment. |

## F. Tests

Measured 2026-09-04, each package after `pnpm install` in its own directory.

| # | Claim | Tier | Proof |
|---|---|---|---|
| F1 | `contracts`: 120 passed, 0 failed, 0 skipped | REPRODUCIBLE | `forge test` |
| F2 | Contract coverage: 99.04% lines, 100.00% functions, 94.92% branches | REPRODUCIBLE | `forge coverage` over `src/` |
| F3 | `cli`: 178 passed | REPRODUCIBLE | `pnpm test` |
| F4 | `gateway`: 115 passed, 4 skipped, **1 file fails to load** | REPRODUCIBLE | `pnpm test`; see the known failure below |
| F5 | `packages/evidence`: 98 passed, 1 skipped | REPRODUCIBLE | `pnpm test` |
| F6 | `solana`: 89 passed, 7 skipped | REPRODUCIBLE | `pnpm test`; the 7 are `devnet.integration`, which needs a funded devnet keypair |
| F7 | `packages/seal`: 83 passed with a local Bee node; 82 passed / 1 skipped without | REPRODUCIBLE | `pnpm test` |
| F8 | **683 passing in total** | REPRODUCIBLE | sum of F1 and F3–F7 |
| F9 | The gateway suite drives a full ERC-3668 round trip against the real `ZegelResolver` on a local anvil, through viem, for both the `data()` and `resolve()` paths | REPRODUCIBLE | `gateway/test/contract.test.ts` |

**Two known failures, stated rather than omitted:**

1. `gateway/test/vercel.test.ts` fails to load — it imports `../api/[[...route]].ts`, which was
   replaced during deployment by a git-ignored esbuild bundle at `api/index.js`. The other nine
   gateway files pass, and the live `/health` endpoint exercises the same boot path.
2. `pnpm test` at the workspace root exits 1. `@zegel/sdk` declares a `test` script but ships no
   test files, so the recursive run stops there. The per-package commands above are the ones to
   run.

**A real bug the anvil cross-check caught:** the resolver allowlist compared un-normalised
addresses, `receipt.contractAddress` came back lowercase, and every lookup 404'd. Nothing short
of a real deploy plus a real HTTP round trip would have found it.

## G. Economics

All MODELED, with every input named and tagged.

**G1 — What one reference costs to anchor on Base.**
Inputs: 91,624 gas (VERIFIED-LIVE, the re-issue anchor tx) × 0.005250 gwei effective gas price
(VERIFIED-LIVE, same receipt) = **0.0000004810 ETH**. Gas price is Base's, not ours, and moves.

**G2 — What the ENS half cost, once.**
Inputs, all VERIFIED-LIVE from receipts: commit 0.0000034084 ETH · register gas 0.0000102862 ETH
· register fee 0.002099590609580475 ETH for one year · resolver deploy 0.0001041955 ETH ·
`setResolver` 0.0000017783 ETH. **Total 0.002219259 ETH**, of which the recurring part is the
0.0021 ETH/year name.

**G3 — Storage cost per reference.**
Inputs: published tiers total 994 + 254,770 = **255,764 bytes** (VERIFIED-LIVE, read back through
ACT). Depth-19 batch cost **0.457331674447872 xBZZ** (VERIFIED-LIVE, on-chain `BatchCreated`).
Effective capacity for depth 19 is **Swarm's own published figure of roughly 112 MB**, which we
did not measure and do not restate as ours. On those inputs the marginal storage cost of one
reference for the batch's lifetime is 0.457 × (255,764 / 112,000,000) ≈ **0.001 xBZZ**, and the
batch amortises across roughly 440 references of this size. Treat the capacity input as the soft
number it is.

**G4 — What revoking the Solana attestation would return.**
Inputs, VERIFIED-LIVE: attestation account rent 2,647,194 lamports + mint rent 5,889,690 lamports
= **0.008536884 SOL** returned. The revoke transaction itself costs on the order of 5,000–9,000
lamports. The subject token account holds a further 1,912,566 lamports, which closure of the
token account rather than revocation would return.

**G5 — Reading is free for a grantee.**
Inputs: the grantee node is unfunded and ultra-light (VERIFIED-LIVE, `0xa11b406c…6aed` with no
postage), and it reads a granted object as HTTP 200 (VERIFIED-LIVE, §6.3). Swarm charges the
uploader, not the reader.

---

## NOT-CLAIMED

Things a reader might reasonably assume. We are not asserting any of them.

1. **We do not claim revocation retracts anything.** A grantee who downloaded a version keeps it,
   and can still fetch versions they were granted by supplying the timestamp. Revocation means
   "cut off from here on". There is no method anywhere in this codebase that implies "unsend",
   and there will not be one. §6.3, row 5, is that limit demonstrated on purpose.
2. **We do not claim privacy from a granted verifier.** A tier-2 grantee learns the wallet
   address. The claim is that the *public* does not, forever — exactly like handing a landlord a
   bank statement rather than publishing it.
3. **We do not claim the 404 is indistinguishable to everyone.** A reader holding the ACT history
   address sees `"act or history entry not found"` where a never-existed read returns bare
   `"Not Found"`. Indistinguishability holds against someone holding only the reference. The gap
   is real and stated.
4. **We do not claim ENSv2 improves privacy.** Its `LabelStore` is an on-chain
   labelhash-to-plaintext database, and reads are fully public. Zegel uses ENSv2's *access
   control*, not its privacy, because it has none. `PermissionedResolver` is write authorisation,
   not read authorisation.
5. **We do not claim the gateway is censorship-resistant.** The operator can refuse to answer and
   the name stops resolving. What they cannot do is read or forge, and the degradation is "the
   name stops working", never "the name resolves to something wrong".
6. **We do not claim sealing through the public Swarm gateway is access control.** That gateway
   holds the publisher private key and will decrypt for anyone presenting the three coordinates.
   The code labels it `confidentiality: 'obscurity'` and refuses to publish tiers sealed that way.
7. **We do not claim a browser can decrypt an ACT object.** ACT decryption happens inside Bee
   with the reader's own key; there is no browser implementation. A grantee must run a node. An
   unfunded ultra-light node is enough, so reading costs nothing — but it is a real ask.
8. **We do not claim ENS name privacy.** The name is public and so is the envelope. Discovery has
   to be public for a counterparty to find anything. What is private is the contents.
9. **We do not claim to have audited Mobula's scoring.** Security scores are Mobula's, reported
   verbatim, including when their check hard-kills WETH on Base to 0/100. We do not second-guess
   an upstream we did not compute.
10. **We do not claim the subject's Solana pubkey is hidden.** It is the attestation nonce and it
    is public. The anchor gives confidentiality of the *contents*, not anonymity of the *parties*.
11. **We do not claim to issue references for wallets we do not control.** Issuing requires an
    EIP-191 control-proof signature over the reference id. Every live reference here is for
    `0x7C7625c8…51a14B`, which is ours. There is no operator override.
12. **We do not claim a commitment match proves the evidence is intact.** It does not — that is
    exactly the failure we found in ourselves. See below.
13. **We do not claim `NOT-FOUND` from the Solana verifier proves an attestation never existed.**
    Public RPCs prune history. The tool says so in its own output.
14. **We do not claim any statement about a wallet's future behaviour.** Every claim is a
    threshold over a stated window of recorded history.
15. **We do not claim `zegel scan` output is stable across runs.** `demo-api.mobula.io`
    rate-limits and some routes return 500s; those sources are recorded as unavailable and the
    claims that would depend on them are omitted, so the same command can produce fewer claims on
    a different day.
16. **We do not claim contract audits.** Nothing here has been audited by a third party. The
    evidence offered is the test suite, the coverage, the invariant runs and the live negative
    controls.
17. **We do not claim `ZegelIssuerRegistry` is production ENSv2 infrastructure.** It is a Sepolia
    subregistry built to exercise four-level EAC scoping and provable revocation. The ENSv2
    addresses it targets rotate on every redeploy — four rotations in three months — and it
    re-checks `code.length` at broadcast time rather than trusting a constant.
18. **We do not claim the `LabelStore`, `RootRegistry` or any other ENSv2 contract is ours.** They
    are ENS's, listed only so their state can be re-checked before a demo.

---

## The honest limits, in full

These are properties of the design, not bugs we intend to fix.

1. **Revocation is forward-only.** A grantee who already downloaded a version keeps it. Revoking
   cuts them off from every future version and cannot retract what they hold. Swarm's own
   documentation says the same: grantees can retrieve the version they were granted, using the
   relevant timestamp, even after access to newer versions is revoked. `revoke()` returns
   `rotationRequired: true` as a reminder that the currently-published bytes are still open to the
   removed key until they are resealed.
2. **A granted verifier learns the wallet at tier 2.** Privacy is from the public, not from your
   counterparty. Tier 1 exists for when even that is too much.
3. **A grantee must run a Bee node to read.** No browser implementation exists. An unfunded
   ultra-light node is enough.
4. **The public Swarm gateway can seal but never unseal.** `GET /addresses` returns 404 there, so
   the ACT publisher key can never be learned and the upload can never be read back — by anyone.
   Verified across every header combination. It looks like a working feature right up until you
   try to read. Zegel therefore runs its own node and says so. Reported to Swarm.
5. **Gateway "confidentiality" is obscurity, not access control.** The gateway node holds the
   private key, so anyone presenting the three coordinates gets plaintext. Only a self-run node is
   key-bound.
6. **Anyone holding the history address can distinguish "revoked" from "never existed".** The two
   produce different error strings.
7. **ENSv2 makes one thing worse, not better.** `LabelStore` is an on-chain
   labelhash-to-plaintext database. ENSv2 adds write-side access control and deletability, and
   zero cryptographic privacy.
8. **The gateway can censor.** Degradation is "the name stops resolving", never "wrong data".
9. **ACT grantee patches are rate-limited to about one per second.** Bee keys each ACT history
   version on the wall-clock second, so two writes inside one second collide.
10. **Security scores are Mobula's, reported verbatim.** Their check hard-kills WETH on Base to
    0/100 over bundler concentration. Even blue chips can read "risky".
11. **A CCIP-Read gateway cannot do read access control.** Not "does not" — cannot. If the
    callback verifies a signer, which is the only design that works, every gateway response is a
    freely replayable bearer token for that record until it expires. Signed therefore means
    public. This is the premise the design is built on, not a gap it routes around.
12. **A locally issued reference is not anchored until someone pays for it.** `verify` reports
    `never-anchored` as a skipped check rather than a failure, because that is a fact about the
    reference and not a problem with it.
13. **`verify` needs the chain to rule out revocation.** When the anchor RPC cannot be reached the
    verdict says "this is a gap in the check, not a pass" rather than returning `valid` as though
    it had looked.

---

## The evidence-integrity failure we found in ourselves

The app's verifier flagged our first published `zegel.eth` reference as **Refused**: 5 of 11
tier-2 sources no longer hashed to the digests recorded beside them.

The cause was ours. The first envelope was assembled with a throwaway Python canonicaliser that
dropped `null` members — matching the TypeScript encoder's treatment of `undefined`, which JSON
does not have — and formatted floats differently from `JSON.stringify`. The recorded bodies were
altered on their way into the seal, so their digests stopped matching.

**Every surface-level check still passed.** The claims re-derived. The commitment matched. The
Base anchor read `Valid`. Only the digest-level re-derivation caught it. **A verifier that had
checked the commitment alone would have accepted altered evidence, and nothing else in this
system would have noticed.**

Fixed by routing everything through the shared `canonicalize()` — one encoder, no exceptions —
and re-issuing. That re-issue is the reference documented throughout PROOF.md, and it is why the
Swarm feed reads index `0000000000000001` rather than `0`.

Two things follow, and both are load-bearing:

- The commitment covers the *claims*, not the raw evidence. Digest-level re-derivation is a
  separate check and it is the one that matters for tier 2. See NOT-CLAIMED #12.
- A negative control is only worth something if it is allowed to fire at you. This one did.
