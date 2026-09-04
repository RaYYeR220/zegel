# Zegel

**Live:** https://zegel-app.vercel.app · **Demo video:** https://youtu.be/Iko5B5-Ato0 · **Resolver gateway:** https://zegel-gateway.vercel.app/health

**A private financial reference.** Prove you are good with money to one specific person, for a limited time, revocably — under an ENS name, without ever revealing the wallet.

---

## The problem

In crypto, proving you are competent with money means pasting your address.

That single act hands over, permanently and to everyone: your net worth, every trade you have ever made, every counterparty, the hours you trade, and — through any modern wallet-label graph — your identity cluster. You cannot take it back, you cannot scope it, and you cannot give one counterparty less than you gave the last one.

Offline this problem was solved centuries ago. You show a landlord a statement for one account over three months. You do not hand them your bank login, and you certainly do not publish it.

Zegel is that statement.

**The adversary is named:** the counterparty who keeps your data after the deal closes, and the chain-analytics industry that buys it from them.

## How it works

```
  live chain data          derived claims              sealed tiers            discovery
 ┌───────────────┐        ┌──────────────┐          ┌──────────────┐       ┌──────────────┐
 │    Mobula     │──────▶ │  derivation  │────────▶ │  Swarm ACT   │◀──────│  zegel.eth   │
 │  positions,   │        │  (pure, its  │          │  encrypted   │       │  ENSIP-24    │
 │  labels,      │        │  rules are   │          │  to a key,   │       │  data()      │
 │  funding,     │        │  hashed into │          │  grant and   │       │  via         │
 │  security     │        │ DERIVATION_ID│          │  revoke      │       │  CCIP-Read   │
 └───────────────┘        └──────────────┘          └──────────────┘       └──────────────┘
                                  │                                                │
                                  └──────────── commitment ────────────────────────┘
                                                     │
                                    ┌────────────────┴────────────────┐
                                    ▼                                 ▼
                          ZegelAnchor on Base              attestation on Solana
                          (expiry + revocation)            (portable credential)
```

**Claims are derived, never declared.** Everything asserted about a wallet is computed from live on-chain data. Nobody types in their own win rate.

**Disclosure is tiered.** The public sees a commitment and an expiry — that a reference exists, nothing more. A tier-1 grantee sees the claims: which thresholds were met, with no raw data and no address. A tier-2 grantee gets the full evidence bundle, every upstream response kept verbatim, and can **re-run the derivation themselves** rather than trusting the issuer.

**Access control is encryption, not a permission check.** An un-granted read of a sealed tier returns `404` — indistinguishable from data that never existed.

### Why the resolver gateway holds nothing secret

CCIP-Read cannot do read access control, and building as though it can is the standard mistake. In ERC-3668 the `sender` field is the resolver contract, not the caller. `eth_call` carries no signature. Through the UniversalResolver the caller your resolver sees is the UniversalResolver. And decisively: if the callback verifies a gateway signature, **every response the gateway emits is a freely replayable bearer token until it expires** — one authorised reader fetches once and can publish the blob.

So Zegel's gateway is deliberately a dumb pipe. It serves only the public envelope. Confidentiality lives in Swarm's Access Control Trie, keyed to a grantee's own secp256k1 key. The gateway operator can censor. They cannot read, and they cannot forge.

## Deployed

| What | Where |
|---|---|
| **`zegel.eth`** | Ethereum mainnet — [registration tx](https://etherscan.io/tx/0xef1d1d55928b1125f72e6c6540870ae62dc38b3a7fa7b69f61b6dff7828ce164) · node `0x16a79596…d7e7` |
| **`ZegelAnchor`** | Base mainnet [`0xbcB85eCdeF23a11D5015b260cC4eDCc0c250f42e`](https://basescan.org/address/0xbcB85eCdeF23a11D5015b260cC4eDCc0c250f42e) · [deploy tx](https://basescan.org/tx/0x7c32343d11f3c74dd4d22f48ad15172d80396aabc9e8808666fa3803a2f5d87d) |
| **Solana attestation** | mainnet [`36A3Fyeid2fauHVs1atAvc8YFvt7tvDSMqofZaeYYQbM`](https://solscan.io/account/36A3Fyeid2fauHVs1atAvc8YFvt7tvDSMqofZaeYYQbM) — soulbound, issued in [this tx](https://solscan.io/tx/35DCZai3bBRZpg24AhpSDFifH4f14b5vvnEZGzu7Y1WuBWbT8Bop36hHc5jZfwc3NqzmcgcZcjm6vNRDoLCN3LEm) |
| **Swarm postage batch** | Gnosis mainnet — [purchase tx](https://gnosisscan.io/tx/0x929fd732a307c5fdd0f0c9a4df6484eff4c8f19e45c05df730b248f64cce5823) · batch `a3da0bac…44c3` |

See [`PROOF.md`](./PROOF.md) for the full evidence chain, including the live grant-read-revoke transcript.

## Repository

| Package | What it is |
|---|---|
| `contracts/` | `ZegelResolver` (ENSIP-10 + ENSIP-24 + ERC-3668), `ZegelAnchor` (commitments, expiry, revocation), `ZegelIssuerRegistry` (ENSv2 Enhanced Access Control, scoped delegation) |
| `packages/evidence/` | Mobula client and the deterministic claim derivation |
| `packages/seal/` | Swarm ACT sealing, grantee grant and revoke |
| `packages/sdk/` | Resolve a reference from a name, verify it against the anchor |
| `gateway/` | The CCIP-Read gateway |
| `solana/` | Solana Attestation Service issuance, revocation and verification |
| `cli/` | Command-line surface |
| `app/` | The web app |

## Tests

| Package | Passing |
|---|---|
| `contracts` | **120** — 99.04% lines, 100% functions, 94.92% branches |
| `cli` | **178** |
| `gateway` | **118** — including a full ERC-3668 round trip against the real resolver on anvil, driven by viem |
| `packages/evidence` | **98** |
| `solana` | **89** |
| `packages/seal` | **83** |
| `packages/sdk` | **16** |
| **Total** | **702** |

```bash
pnpm install
cd contracts && forge test              # 120
cd cli       && pnpm test               # 178
cd gateway   && pnpm test               # 118
cd packages/evidence && pnpm test       # 98
cd solana    && pnpm test               # 89
cd packages/seal && pnpm test           # 83
cd packages/sdk  && pnpm test           # 16
```

Run them per package. A recursive run from the root is not the supported path — see [`CLAIMS.md`](./CLAIMS.md).

## Honest limits

These are properties of the design, not bugs we intend to fix. A reference system that claimed otherwise would be lying.

1. **Revocation is forward-only.** A grantee who already downloaded a version keeps it. Revoking cuts them off from every future version and cannot retract what they hold. There is no method in this codebase that implies "unsend", because no such thing exists.
2. **A granted verifier learns the wallet at tier 2.** Privacy here is from the public, not from your counterparty — exactly like handing a landlord a bank statement. Tier 1 exists for when even that is too much.
3. **A grantee must run a Bee node to read.** ACT decryption happens inside Bee with the grantee's own key; there is no browser implementation. An unfunded ultra-light node is enough, so reading costs nothing — but it is a real ask.
4. **The public Swarm gateway can seal but never unseal.** `GET /addresses` returns 404 there, so the publisher key cannot be learned and the upload cannot be read back by anyone. Sealing through it looks like it works right up until you try to read. Zegel therefore runs its own node, and says so.
5. **Anyone holding the history address can distinguish "revoked" from "never existed"** — the two produce different error strings. Indistinguishability holds against someone holding only the reference, which is the threat model that matters, but the gap is real.
6. **ENSv2 makes one thing worse, not better.** Its `LabelStore` is an on-chain labelhash-to-plaintext database. Zegel uses ENSv2's access control, not its privacy, because it has none.
7. **Security scores are Mobula's, reported verbatim.** Their check hard-kills WETH on Base to 0/100 over bundler concentration. We do not second-guess an upstream we did not compute.

## License

MIT
