# `@zegel/evidence`

The evidence engine behind a Zegel reference.

A Zegel reference is a private financial reference: it proves something true about a wallet's
trading history to **one** named person, for a limited time, revocably, without publishing the
wallet. This package produces the evidence those proofs are made of.

It does two things, and deliberately nothing else:

1. **Collect** — pull a wallet's real trading record from Mobula and keep every upstream response
   *verbatim*, with its digest, its parameters, and the moment it was fetched.
2. **Derive** — turn those responses into a fixed set of plain-English claims through a pure,
   deterministic function whose rules are themselves hashed into `DERIVATION_ID`.

No chain writes, no sealing, no keys. Those live in `@zegel/seal` and `contracts/`.

## Why it is built this way

The trust model of the product is *"the grantee re-runs the derivation themselves rather than
trusting us."* Two properties follow, and everything in here serves them:

- **Deterministic.** `deriveClaims(bundle)` reads no clock, no network and no environment. The end
  of the evidence window is the only notion of "now". The same bundle produces byte-identical
  claims on any machine, so a grantee can recompute them and get the same answer we did.
- **Never fabricated.** If an upstream call fails, the source is recorded as `unavailable` with its
  HTTP status and no body, and every claim that would have depended on it is **omitted entirely**.
  A reference with eight claims and an honest gap is worth more than one with ten claims and an
  invented number. `verifyClaims` treats a body smuggled onto an unavailable source as tampering.

## Quick start

```ts
import { buildEvidence, toClaimSet, verifyClaims } from '@zegel/evidence';

// No API key, no signup: defaults to https://demo-api.mobula.io.
// Set MOBULA_API_KEY and it switches to https://api.mobula.io.
const bundle = await buildEvidence('0xd8dA…6045', {
  chains: ['evm:1', 'evm:8453', 'solana'],
  windowDays: 90,
});

verifyClaims(bundle); // { ok: true, mismatches: [] }
toClaimSet(bundle);   // tier 1: no address, no bodies, no measured values
```

## The Mobula endpoints, and why each one is here

Everything below was verified live against `demo-api.mobula.io` with no credentials.

| Endpoint | What it gives us | Why the product needs it |
| --- | --- | --- |
| `GET /2/wallet/positions-history` | Every **closed position cycle** with its own realized PnL, entry and exit dates, fees and swap count | This is the whole spine. A balance says what someone holds today; a cycle is a completed decision with an outcome. Realized PnL, closed-trade count, win rate, drawdown, holding period and concentration all come from here. Nothing else in the market exposes trades as discrete, closed, individually-attributed cycles. |
| `GET /2/wallet/positions` | Current holdings with realized and unrealized PnL per chain | Open exposure. It is what the live positions stream updates, and it is the polling fallback when streaming is not available. |
| `GET /2/wallet/trades` | Per-swap fee decomposition: `gasFeesUSD`, `platformFeesUSD`, **`mevFeesUSD`** | The only place we found that separates out what MEV bots took. "How much of what you paid was taken by bots trading ahead of you" is a real signal about execution discipline, and it is legible to someone who has never opened a block explorer. |
| `GET /2/wallet/labels` | Mobula's wallet label taxonomy — `proTrader`, `smartTrader`, `sniper`, `insider`, `bundler` | Context a counterparty would otherwise have to buy from a chain-analytics vendor. Collected into the bundle for the exposure view; no claim depends on it, because an empty label set is the common case and must not be read as a negative. |
| `GET /2/wallet/funding` | The **first inbound transfer that ever funded the wallet**, with enriched funder metadata | Fixes wallet age from something that cannot be backdated. "This wallet has been in use for at least 180 days" is one of the most useful sentences a landlord or a lender can read, and it is exactly the sentence a fresh sockpuppet cannot produce. |
| `GET /2/token/security` | A 0–100 **`securityScore`** with a 14-check itemised breakdown — LP burn, top-10 concentration, bundler / insider / sniper activity, volume manipulation, freeze and mint authority, token age, sell tax, blacklists, smart-money conviction — plus hard-kill reasons | **The differentiator.** Raw PnL says whether someone got lucky. This says *what risk they took to get it*. "Did this person knowingly trade rug-scored tokens" is a far better reference signal than a profit number, and no other data provider ships a weighted, explainable score — flag lists are not the same thing. It drives `risk-quality-ratio`, the claim we lean on. |
| `GET /2/market/lighthouse` | Global market aggregate: volume, trades, buys, sells and fees paid at 15m/1h/6h/24h, sliced by chain, DEX, launchpad and platform | The denominator. A profit figure means nothing without the market it happened in; this is what lets the app say whether a record was made in a rising market or against one. |
| `POST /graphql` — `filterTokens`, `tokenTopTraders` | Screener rows, and a token's top traders ranked by realized PnL | Open over HTTP with **no auth at all**, so the exposure view works for a reviewer with zero credentials. `tokenTopTraders` is the demonstration of the threat the product exists to answer: it is exactly the shape the deanonymisation industry builds on. |

### Attempted, and honestly reported as unavailable

`/2/wallet/analysis`, `/2/wallet/defi-positions` and `/1/wallet/history` return real 500s on the
demo host. They are still attempted, and still recorded in the bundle as sources marked
`unavailable` with their status — a reader should be able to see what we tried and could not get,
not only what we got. Nothing derived depends on them. They are flaky rather than dead: during
fixture recording, `/2/wallet/analysis` and `/1/wallet/history` both answered 200 for one wallet in
the same run in which they failed for another.

## Chain identifiers are not consistent, and we normalise them

Mobula spells chains several different ways depending on which surface answers. Observed live:

| Surface | Spelling |
| --- | --- |
| REST request filter | `chainIds=evm:8453`, `chainIds=solana` |
| Token objects | `chainId: "evm:8453"`, `chainId: "solana:solana"` |
| `/2/wallet/trades` | `blockchain: "Ethereum"`, `"Base"` — display names |
| GraphQL | integer `networkId`; Solana is `1399811149` |

`normalizeChain()` folds all of them into the canonical Zegel form (`evm:<decimal>` or `solana`) and
returns `null` for anything it cannot place, so an unknown chain is skipped rather than guessed at.
**Raw bodies are never rewritten** — normalisation happens only where values are compared or
grouped, so a verifier re-derives from exactly what the upstream returned.

One more filter quirk worth knowing: `blockchain=` and `blockchains=` are silently ignored by the
wallet endpoints. `chainIds=` is the one that actually filters.

## The claims

Ten, all derived, none self-declared. Statements assert the *threshold*, never the measured
value — a tier-1 grantee reads them without `actual`, so a sentence that quoted the real number
would defeat the tier split.

| id | unit | rule |
| --- | --- | --- |
| `realized-pnl-usd` | usd | Sum of realized PnL over closed cycles that exited inside the window |
| `closed-position-cycles` | count | How many complete buy-and-sell trades that is |
| `win-rate` | ratio | Share of those cycles that made money |
| `max-drawdown-usd` | usd | Deepest peak-to-trough fall of the cumulative realized PnL curve |
| `median-holding-period-days` | days | Median of exit minus entry — an investor against a bot |
| `trading-cost-ratio` | ratio | Fees over gross traded volume |
| `mev-fee-share` | ratio | Share of trading costs taken by bots front-running the wallet |
| `risk-quality-ratio` | ratio | Share of traded assets Mobula scores below 60/100, or hard-kills outright |
| `position-concentration` | ratio | Largest single asset's share of gross traded volume |
| `wallet-age-days` | days | Days since the first time anyone funded the wallet |

Thresholds are fixed module constants rather than per-caller options, on purpose: every reference is
scored by the same bar, so two references are directly comparable — and `DERIVATION_ID` proves they
were. A caller-tunable threshold would let an issuer shop for a bar their subject happens to clear.

`deriveMetrics(bundle)` returns the full numeric picture behind the claims — cycle list, security
readings, MEV split, unscored-asset count — for the app to show the working.

## `DERIVATION_ID`

A sha256 over the derivation's rules and parameters: every claim id, operator, threshold, unit,
formula and the upstream fields it reads, plus the ordering, rounding and window conventions. Two
bundles carrying the same `derivationId` were provably scored by the same rules; `verifyClaims`
rejects a bundle whose `derivationId` is not the current one rather than quietly re-scoring it.

It hashes a structural descriptor of the rules rather than the module's own source bytes, because
source bytes are not stable across platforms — line endings, bundlers and minifiers all change them
without changing a single rule, which would make the id differ between the issuer and the verifier
for no reason. A test asserts the descriptor and the implementation cannot drift apart: every claim
the derivation emits must match the descriptor's operator, threshold, unit and statement, and the
counts must be equal.

## The negative control

`verifyClaims(bundle)` is the re-run. It:

1. rejects a bundle whose `derivationId` is not this build's;
2. recomputes `sha256(canonical(body))` for every source and compares it to the stored digest;
3. re-derives every claim from `sources[].body` and compares statement, operator, threshold, unit,
   `passed`, `actual` and source indices;
4. flags claims that were invented, dropped, or attached to an unavailable source.

Tests cover a nudged number, a nudged number *with the digest resealed* (so only re-derivation
catches it), a flipped `passed`, a rewritten `actual`, an invented claim, a dropped claim, a body
smuggled onto an unavailable source, and a foreign `derivationId`.

## Live streaming degrades visibly

Mobula gates every WebSocket stream behind a paid plan. Without such a key there is no live feed at
all, so `openPositionsStream()` returns a session that always says which mode it is running in and
carries a sentence the UI prints verbatim:

```
Live streaming unavailable (Mobula WebSocket requires a paid plan key) - polling at 15s
```

The polling fallback delivers the same callback shape. Silently polling and calling it "live" would
be the one lie this product cannot afford.

## Credit meter

`x-ratelimit-cost`, `-limit` and `-remaining` come back on every response and are pushed through
`client.rateLimit` — `latest`, `spent`, `history` and `subscribe()` — so the app can render a live
budget meter. `estimateCredits(options)` prices a collection before it runs. Credits are the real
constraint: `/2/token/security` costs 10 each, which is why security lookups are ranked by traded
volume and capped.

Retries are exponential backoff with full jitter. 429, 408 and 5xx are retryable; every other 4xx is
terminal, because retrying our own bad request only burns credits. A server-sent `retry-after` wins
over our own backoff.

## Why the client is hand-rolled

`@mobula_labs/sdk` exists and works, but it wraps axios, does not surface the rate-limit headers,
and returns parsed convenience objects rather than the response body as it arrived. This package
needs the opposite of convenience: the **verbatim** body, its digest, its exact parameters and the
credit headers, because that tuple is what a grantee re-derives from. A thin `fetch` wrapper gives
all of it in about 250 lines and adds no dependencies — `@noble/hashes` is the only runtime dep, and
that is inherited from the shared digest helper.

## Tests

```
pnpm install
pnpm test          # everything, including live calls
```

Unit tests run against **real recorded Mobula responses** in `test/fixtures/`, captured from the
demo host — not invented JSON. Re-record with:

```
ZEGEL_RECORD=1 pnpm vitest run scripts/fixtures.record.ts
```

`test/live.test.ts` calls `demo-api.mobula.io` and `graphql.mobula.io` for real and skips itself
when the host is unreachable, so an offline machine does not turn into a red build.

## Notes for whoever wires this up

- `@zegel/sdk` has no manifest yet, so its two source files are reached through a path alias in
  `tsconfig.json` and `vitest.config.ts`. When that package gains a `package.json`, replace both
  aliases with a normal `workspace:*` dependency; `src/sdk.ts` is the single import point, so it is
  a one-file change.
- `buildEvidence` fills `controlProof` with an **empty** signature when none is supplied. Empty
  means "control not yet proven" — it is never treated as valid. `controlProofMessage(referenceId)`
  returns the exact string the subject wallet must sign; `isControlProven(bundle)` is the check.
- `referenceId` defaults to 32 random bytes rather than a digest of the address. Deriving it from
  the subject would let anyone who guesses an address confirm the guess against the public envelope.
