# `@zegel/solana` — the portable, revocable anchor

A Zegel reference is a private financial statement about a wallet: derived from live
chain data, sealed under an ENS name, readable only by the counterparty you granted.
Off-chain, that reference is an encrypted object on Swarm. This package is what makes
it a **credential** rather than a file we host:

- **Portable off Ethereum.** The public commitment is anchored on Solana as a
  [Solana Attestation Service](https://attest.solana.com/docs) attestation. Anyone
  holding three public values — the issuer's pubkey, the subject's pubkey and the
  reference id — derives the account address offline and reads it from any RPC. No
  index, no API key, no cooperation from us.
- **Revocable, observably.** The attestation is *tokenized*: a soulbound Token-2022
  NFT is minted alongside the PDA. Revocation closes both. That is an on-chain state
  change a third party sees for themselves, not a claim we make on a webpage.
- **Tamper-evident.** The anchored value is `sha256` over the canonical `ClaimSet`.
  A claim set with one number edited hashes differently and fails verification with
  a specific status, not a vague error.

Program: [`22zoJMtdu4tQc2PzL74ZUT7FrwgB1Udec8DdW4yw4BdG`](https://explorer.solana.com/address/22zoJMtdu4tQc2PzL74ZUT7FrwgB1Udec8DdW4yw4BdG)
— permissionless, live on mainnet and devnet.

---

## The model

SAS has three account types. Zegel uses one of each, at fixed names, so every address
is a pure function of the issuer's pubkey.

```
Credential  "zegel"                the issuer identity + its authorized signers
   └─ Schema  "reference" v1       the field layout, versioned and pausable
        └─ Attestation             one per subject: the commitment, expiry, derivation pin
             └─ Token-2022 NFT     soulbound, minted to the subject, burnable by the issuer
```

### PDAs

Every seed below is literal. Nothing is stored, everything is derived.

| Account | Seeds |
|---|---|
| Credential | `["credential", authority, "zegel"]` |
| Schema | `["schema", credential, "reference", 1u8]` |
| Attestation | `["attestation", credential, schema, nonce]` — **`nonce` = the subject's pubkey** |
| Schema mint (group) | `["schemaMint", schema]` |
| Attestation mint (member) | `["attestationMint", attestation]` |
| SAS authority | `["sas"]` |
| Event authority | `["__event_authority"]` |
| Subject's token account | standard Token-2022 ATA of `(subject, attestationMint)` |

For the Zegel issuer authority `BW2UCEkixRcSAAsfUEKe2YZMXLNUMwxZqBpCGBEQ7tD9` those
resolve to:

```
credential   E71jA1xf49cCJFVcvDxhqm8eDDF6mcf8VFgoCaWfpSen
schema       GpmsvJCNeKBkuwm25vY9vjzh89ojaqCiNActrZAq1EKC
schema mint  H8LCwFpia1QvwRH3eZsNJg9731nRWPpQ3qbK3rJmKKua
```

These are pinned in `test/pdas.test.ts`. Changing `CREDENTIAL_NAME`, `SCHEMA_NAME` or
`SCHEMA_VERSION` relocates every account and orphans live attestations, so the test
fails loudly if anyone edits them.

> **One live reference per subject.** The attestation nonce is the subject's pubkey,
> so `(issuer, schema version, subject)` maps to exactly one PDA. Issuing a second
> reference for the same subject is refused with `AttestationExistsError` — the
> issuer has to revoke the first. That is deliberate: two contradictory live
> references for one person is not a state worth supporting.

### The schema

Five fields, fixed at version 1. Schema fields are consensus between issuer and
verifier, so the list stays short and carries **no claim contents** — only the
commitment and what is needed to check it.

| Field | Type | Layout byte | Bytes |
|---|---|---|---|
| `referenceId` | `Vec<u8>` (32) | 13 | 36 |
| `commitment` | `Vec<u8>` (32) | 13 | 36 |
| `expiresAt` | `u64` | 3 | 8 |
| `derivationId` | `Vec<u8>` (32) | 13 | 36 |
| `tierCount` | `u8` | 0 | 1 |

Borsh payload: **117 bytes**, held down by a round-trip test that encodes and decodes
against a schema account reconstructed from raw bytes, exactly as the verify path does.

`commitment` is `sha256` over the canonical `ClaimSet` — the same
`canonicalDigest()` the rest of the monorepo uses. `derivationId` pins which
derivation produced the claims, so two references scored by the same rules are
comparable. `expiresAt` is mirrored into the attestation's own `expiry` field: the
program enforces one, a verifier reading only the Borsh payload sees the other.

### One gotcha worth writing down

`sas-lib` exports `SolanaAttestationServiceAccount` as `{ Attestation: 0, Credential: 1,
Schema: 2 }`. That is a Codama **account index**, not the byte the program writes.
The real discriminators, confirmed by filtering live devnet accounts on byte 0, are:

| Account | On-chain discriminator |
|---|---|
| Credential | `0` |
| Schema | `1` |
| Attestation | `2` |

Exported here as `ACCOUNT_DISCRIMINATOR`. Anyone writing a `memcmp` filter against SAS
needs these, not the enum — `test/devnet.read.test.ts` re-checks them against the live
cluster on every run.

### Why tokenized

`CreateTokenizedAttestation` mints a Token-2022 NFT to the subject with seven
extensions. Three of them do the actual work:

- **`NonTransferable`** — the subject cannot move the credential to another wallet,
  so the address a verifier checks is the address that holds it.
- **`PermanentDelegate`** (held by the SAS program authority) — the issuer can burn
  it without the subject's signature.
- **`MintCloseAuthority`** — and close the mint afterwards, so nothing is left.

The other four (`GroupPointer` on the schema mint, `GroupMemberPointer`,
`MetadataPointer` + `TokenMetadata` embedding the attestation and schema addresses)
make the credential legible in any Token-2022 wallet without an indexer.

The `TokenMetadata` `uri` defaults to a self-contained `data:` URI, on purpose. A
hosted metadata JSON would add a server that can go dark without any on-chain change —
exactly the dependency this credential exists to remove. The authoritative record is
the attestation account plus the ENS envelope; the URI carries its own payload.

---

## Revocation, and how a third party sees it

SAS has no update instruction and no revoked flag. An attestation exists or it does
not. Revoking therefore means **closing** the attestation PDA — and for a tokenized
attestation, burning the NFT and closing its mint in the same instruction.

This package exposes the same primitive under two names, because the two intents
have different consequences:

| | intent | guard |
|---|---|---|
| `revoke()` | issuer withdraws a **live** reference | none |
| `close()` | issuer reclaims rent from a **lapsed** reference | refuses if `expiry > now`, unless `force: true` |

`close()` on a live reference throws `AttestationNotExpiredError` and tells you to
call `revoke()` instead. Closing a live credential is revocation; an operation with
that consequence should have to be named.

**How anyone else observes it, without trusting us:**

1. Derive the attestation PDA from the three public values. `getAccountInfo` returns
   `null` — the credential is gone.
2. `getSignaturesForAddress` on that same PDA still returns the closing transaction.
   Fetch it and you will find a `CloseTokenizedAttestation` instruction to the SAS
   program, signed by the issuer's credential authority, carrying a
   `CloseAttestationEvent` emitted through the program's event-authority self-CPI.
3. The soulbound NFT is burned and its mint closed, so the subject's token account
   is empty too.

`verify()` does exactly this and reports `revoked` with the signature, slot and block
time. `zegel-sas verify --json` prints them.

**The close has to be positively identified.** An absent account plus *some* activity
at the address is not evidence of revocation. Attestation addresses are derivable by
anyone — that is the whole portability argument — which means anyone can name one in a
transaction of their own for the price of a fee. Treating that as "the issuer closed
it" would let a stranger fabricate an act by the issuer. So `verify` decodes candidate
transactions (top-level **and** inner, since a close reached through a multisig is a
CPI) and reports `revoked` only when it finds a real `CloseAttestation` or
`CloseTokenizedAttestation`. It walks back a few transactions, so later traffic at the
address cannot bury the close.

**Honest limit:** step 2 depends on the RPC retaining transaction history for the
address. Public RPCs prune. When the close cannot be identified, this package answers
`not-found` and says which case it is in — no history at all, or unexplained history
that proves nothing — rather than silently upgrading a gap in one node's memory into a
claim about the world. Both answers are non-`valid`, so the failure direction is safe:
a genuine revocation that the RPC has forgotten reads as `not-found`, never the other
way round. The closing transaction itself is permanent; only a given node's index of
it is not.

---

## Verification status matrix

`verify()` returns a status, never a bare boolean. Precedence runs most-specific
first so a milder answer never hides a worse one.

| Status | Meaning |
|---|---|
| `not-found` | Nothing anchored at the derived address, and no history there. Also returned when the issuer has never set up a credential on this cluster. |
| `revoked` | The attestation existed and the issuer closed it. Carries the closing signature. |
| `reference-mismatch` | This subject holds a live reference, but a different one. |
| `commitment-mismatch` | **The negative control.** The claim set presented does not hash to the anchored commitment. |
| `schema-paused` | The issuer suspended the whole schema; nothing under it should be relied on. |
| `expired` | Past the expiry the program enforces. |
| `valid` | Live, and the commitment matches. |

`commitment-mismatch` deliberately outranks `expired` and `schema-paused`: a tampered
claim set has to fail *as a tampered claim set*, whatever the clock says. If no
commitment is supplied, `verify` can still return `valid` — and says so explicitly in
`detail`, because it checked existence and expiry but not contents.

The full matrix, including precedence and both revocation paths, is exercised in
`test/verify.test.ts` against served account bytes; the live path is exercised in
`test/devnet.integration.test.ts`.

---

## CLI

`status` and `verify` need **no keypair**. That is the point: a verifier runs the same
binary against a public RPC and reaches the same verdict the issuer does.

```bash
cd solana
pnpm install
```

Node 24 runs the TypeScript directly, so there is no build step for the CLI:

```bash
pnpm cli --help          # or: node src/cli/index.ts --help
```

Or build and use the bin:

```bash
pnpm build
node dist/cli/index.js --help    # installed as `zegel-sas`
```

### Read-only, no credentials

```bash
# is the issuer set up on this cluster, and is the schema paused?
node src/cli/index.ts status \
  --cluster devnet \
  --issuer BW2UCEkixRcSAAsfUEKe2YZMXLNUMwxZqBpCGBEQ7tD9

# check a reference against the chain
node src/cli/index.ts verify \
  --cluster devnet \
  --issuer BW2UCEkixRcSAAsfUEKe2YZMXLNUMwxZqBpCGBEQ7tD9 \
  --subject <SUBJECT_PUBKEY> \
  --reference-id 0x<64 hex> \
  --commitment  0x<64 hex>

# the negative control: same command, one byte changed in --commitment
# => status COMMITMENT-MISMATCH, exit code 2
```

`verify` exits `0` on `valid` and `2` on any other status, so it drops straight into a
shell script or CI check. `--json` prints the whole result including every derived
address.

### Issuer-only

```bash
export ZEGEL_SOLANA_KEYPAIR=/path/to/issuer.json    # never inside this repo
export ZEGEL_SOLANA_RPC=https://api.devnet.solana.com

node src/cli/index.ts issue \
  --subject <SUBJECT_PUBKEY> \
  --reference-id  0x<64 hex> \
  --commitment    0x<64 hex> \
  --derivation-id 0x<64 hex> \
  --expires-at    2026-12-31T00:00:00Z

node src/cli/index.ts revoke --subject <SUBJECT_PUBKEY>
node src/cli/index.ts close  --subject <SUBJECT_PUBKEY>   # refuses if not yet expired
```

The first `issue` (or any issuer command) runs setup idempotently: it creates the
credential, schema and schema group mint only if they are absent, in one transaction,
and sends nothing at all on a second run.

---

## Library

```ts
import { createIssuer, issue, revoke, verify } from '@zegel/solana';

const issuer = await createIssuer({ rpcUrl, keypair });   // idempotent setup

await issue({
  issuer,
  subject,                 // Solana pubkey — becomes the attestation nonce
  referenceId,             // 32-byte hex
  commitment,              // sha256 over the canonical ClaimSet
  expiresAt,               // ISO string, Date, or unix seconds
  derivationId,            // 32-byte hex
});

// a verifier, with no key and no issuer cooperation:
const result = await verify({ rpcUrl, issuerAuthority, subject, referenceId, commitment });
result.status;   // 'valid' | 'expired' | 'revoked' | 'not-found' |
                 // 'commitment-mismatch' | 'reference-mismatch' | 'schema-paused'

await revoke({ issuer, subject, referenceId });
```

`createIssuer` accepts a `KeyPairSigner`, a 64-byte `Uint8Array`, or a byte array;
`loadKeypairFile(path)` reads the standard Solana CLI JSON format. **No key material
is bundled, defaulted or written anywhere by this package** — `src/keypair.ts` is the
only file that touches the filesystem, and it has no default path.

---

## Deployment status

| Cluster | State |
|---|---|
| **devnet** | Read path verified live: the program is deployed and executable, real on-chain SAS accounts decode through this stack, and the derived addresses resolve. The **write** lifecycle has not been run — the issuer authority `BW2UCEkixRcSAAsfUEKe2YZMXLNUMwxZqBpCGBEQ7tD9` holds 0 SOL and the public devnet faucet answers `429 — "You've either reached your airdrop limit today or the airdrop faucet has run dry"` from this network. `faucet.solana.com` requires GitHub sign-in. |
| **mainnet** | Not deployed. |

To unblock devnet, the authority needs roughly **0.02 SOL** — enough for setup plus one
full issue → verify → revoke cycle, with slack. Then:

```bash
ZEGEL_SOLANA_KEYPAIR=/path/to/issuer.json pnpm test
```

runs the whole lifecycle and prints the signatures.

### Mainnet funding

| | SOL |
|---|---:|
| Issuer setup (credential + schema + group mint), one time | 0.005946687 |
| One reference (attestation + NFT mint + subject ATA) | 0.010500114 |
| Transaction fees, 3 signatures | 0.000015 |
| **Minimum for one end-to-end cycle** | **0.016461801** |
| Recommended, covering ~4 references and priority fees | **0.05** |

Revoking refunds the attestation and mint rent, so the marginal cost of a reference
that is later revoked is close to the ATA rent plus fees.

---

## Costs

Measured against live rent parameters (identical on devnet and mainnet), not estimated:

| Account | Bytes | Rent-exempt |
|---|---:|---:|
| Credential | 78 | 0.001304598 SOL |
| Schema | 243 | 0.002349543 SOL |
| Schema group mint | 234 | 0.002292546 SOL |
| **Issuer setup, one time** | | **0.005946687 SOL** |
| Attestation | 290 | 0.002647194 SOL |
| Attestation NFT mint | 802 | 0.005889690 SOL |
| Subject's token account | 182 | 0.001963230 SOL |
| **Per reference** | | **0.010500114 SOL** |

Plus 0.000005 SOL per transaction (setup, issue, revoke — one signature each).

Revoking refunds the attestation and mint rent to the payer. The one-time setup rent
is recoverable only by tearing down the credential. These are queried live from
`getMinimumBalanceForRentExemption`; devnet and mainnet share rent parameters.

---

## Testing

```bash
pnpm test
pnpm typecheck
```

Five suites run with no credentials of any kind:

| Suite | What it holds down |
|---|---|
| `test/schema.test.ts` | Borsh round-trips including boundary values, the 117-byte size, field-name encoding, hex validation, expiry parsing, and schema-drift detection for a reordered, retyped or extended layout. |
| `test/pdas.test.ts` | Every derivation, pinned to literal addresses so renaming a seed fails loudly. |
| `test/instructions.test.ts` | The built `CreateTokenizedAttestation` and both close instructions, decoded back with the program's own Codama parsers: account order and roles, the nonce, the mirrored expiry, the Borsh payload, and the mint sizing. |
| `test/verify.test.ts` | The full status matrix and its precedence, both revocation paths (including one reached through a CPI), the refusal to read unexplained address activity as a revocation, and the tampered-commitment negative control. |
| `test/lifecycle.test.ts` | The refusals — duplicate issue, uninitialised issuer, drifted schema, closing a live or never-expiring reference, a stale reference id — and setup idempotency. |

`test/devnet.read.test.ts` additionally hits the **live cluster** — no key, no funds —
to confirm the program is deployed, that real on-chain SAS accounts decode through the
pinned stack, and that the hard-coded discriminators are the ones the program writes.
It skips itself if devnet is unreachable.

The devnet write lifecycle skips itself unless an issuer keypair is present **and**
funded, and prints the reason it skipped:

```bash
ZEGEL_SOLANA_KEYPAIR=/path/to/issuer.json \
ZEGEL_SOLANA_RPC=https://api.devnet.solana.com \
pnpm test
```

It runs the full lifecycle against a freshly generated subject each time — setup →
issue → verify `valid` → verify a tampered commitment → refuse a duplicate issue →
refuse an early `close` → revoke → verify `revoked` → verify an unknown subject
`not-found` — and prints the transaction signatures it produced.

---

## Pinned versions, and one deliberate override

`@solana/kit@8.2.0` · `sas-lib@1.0.10` · `@solana-program/token-2022@0.16.1` ·
`@solana-program/compute-budget@0.18.1`.

Not used, on purpose: `@solana/web3.js` v1 (superseded by kit), `@solana/wallet-adapter-*`
(superseded), Blinks / `@solana/actions` (vendor sunset notice).

`sas-lib@1.0.10` declares `@solana/kit: ^5.0.0`. Left alone, pnpm installs a second
copy of kit and the two `Address` / `Rpc` type families stop being assignable — the
package will not typecheck. `package.json` therefore carries:

```json
"pnpm": { "overrides": { "sas-lib>@solana/kit": "8.2.0" } }
```

That is safe here rather than hopeful: every kit symbol `sas-lib` touches at runtime —
codec, PDA and account helpers plus `AccountRole` — exists in 8.2.0 with identical
semantics, and `AccountRole`'s numeric values are unchanged. The override is
verified by the suite passing and by the live devnet reads it performs.

> ⚠️ **Monorepo note.** pnpm honours `pnpm.overrides` only from the **workspace root**
> package.json. This package installs and tests standalone (`cd solana && pnpm install
> --ignore-workspace`, which is what its own `pnpm-lock.yaml` pins), but a root-level
> `pnpm install` will ignore the override, pull a second copy of kit, and break the
> typecheck. When wiring this into the monorepo, copy the same override into the root
> `package.json`.

---

## Trust model, stated plainly

- **The issuer can revoke unilaterally.** That is the feature. A reference you cannot
  take back is a reference you cannot safely give.
- **The issuer cannot alter a live reference.** There is no update instruction. The
  only change available is closure, and closure is public.
- **A revoked reference is cut off from here on, not unsent.** Anyone who already read
  the claims keeps what they read. Revocation stops future verification, which is what
  a reference letter can honestly promise.
- **The anchor leaks nothing.** The attestation holds a commitment, an expiry, a
  derivation id and a tier count. It contains no claim, no number, no address of the
  subject's EVM wallet. What is public is that a reference exists for this Solana
  pubkey and when it lapses.
- **The subject's Solana pubkey is public.** It is the attestation nonce. This anchor
  gives confidentiality of the *contents*, not anonymity of the *parties*.
- **Verification of the commitment requires the claim set.** Someone who has not been
  granted a tier can confirm a reference exists and has not been revoked, and nothing
  more.
