# Zegel — contracts

Three contracts, one product: a private financial reference you can hand to one person, for a limited
time, and take back.

| Contract | Chain | Job |
|---|---|---|
| `ZegelResolver` | Ethereum mainnet (1) | ENS resolver. Serves the public sealed envelope under ENSIP-24 `data()`, over ERC-3668 CCIP-Read. |
| `ZegelAnchor` | Base mainnet (8453) | The commitment, the expiry, and the revocation — all readable without decrypting anything. |
| `ZegelIssuerRegistry` | Sepolia (11155111) | ENSv2 subregistry demonstrating four-level Enhanced Access Control scoping: delegate one record on one name, then take it back provably. |

```
forge build
forge test
```

**`forge test`: 120 passed; 0 failed; 0 skipped (4 suites).**
Coverage over `src/`: 99.04% lines, 100.00% functions, 94.92% branches.

---

## The trust model, stated first

A CCIP-Read gateway **cannot authenticate its caller**. This is not a gap we route around; it is the
premise the design is built on.

- `sender` in `OffchainLookup` is the resolver contract, not the reader. It is a routing field.
- `eth_call` carries no signature. `msg.sender` is whatever the caller puts in the JSON-RPC `from`
  field, and through the UniversalResolver it is the UniversalResolver. ERC-3668's own security
  section tells application authors not to send `from` at all, and viem, ethers and wagmi comply.
- Therefore a resolver that authenticates a **signer** (the only design that works) makes every
  gateway response a **freely replayable bearer token** for that record until `expires`. One
  authorised reader fetches once and can publish the signed blob. **Signed means public.**

So the gateway is never given anything that needs protecting. What it serves is a commitment hash, an
expiry, Swarm references and an anchor pointer — metadata *about* ciphertext. The claims themselves
are sealed under Swarm ACT, encrypted to a named recipient's secp256k1 key, which needs no HTTP
authentication to be sound. An un-granted read of the sealed object returns 404, indistinguishable
from a reference that never existed.

> **Swarm ACT is the access control. The resolver and its gateway are discovery.**
> The gateway can censor. It cannot read, and it cannot forge.

### What the resolver does enforce

| Property | Mechanism |
|---|---|
| Authenticity | Owner-managed on-chain signer allowlist. |
| Query binding | The signature covers `callData`, which carries the DNS-encoded name and the record key. A response for one name cannot be replayed against another. |
| Resolver binding | The signature covers `address(this)`. A response cannot move between two resolvers that trust the same signer. |
| Freshness | `expires` enforced against `block.timestamp`. |
| Callback binding | `extraData` carries this contract's address and the callback rejects anything else. |
| Failure mode | Degrades to "the name stops resolving", never to "the name resolves to something wrong". |

### What it does not, and cannot, enforce

- **Read access control.** See above. Anything that must stay secret is encrypted before it reaches
  the gateway.
- **Unsending.** Revocation is "cut off from here on". A grantee keeps whatever they already
  downloaded — the same as any reference letter you have already handed over.
- **Censorship resistance.** A gateway operator can refuse to answer.
- **Privacy from a granted verifier.** A tier-2 grantee learns the wallet. The point is that the
  whole world does not, forever.

---

## Interface ids and selectors

Each of these is asserted in `test_InterfaceIdsMatchTheStandards` and `test_InterfaceIds` rather than
left to drift, because a wrong selector fails silently in clients and loudly nowhere.

| Id | Standard | Where |
|---|---|---|
| `0x9061b923` | ENSIP-10 `resolve(bytes,bytes)` | `ZegelResolver` |
| `0xecbfada3` | ENSIP-24 `data(bytes32,string)` | `ZegelResolver` |
| `0x29fb1892` | ENSIP-24 `supportedDataKeys(bytes32)` | `ZegelResolver` |
| `0x582de3e7` | ERC-7996 / ENSIP-22 `supportsFeature(bytes4)` | `ZegelResolver` |
| `0x556f1830` | ERC-3668 `OffchainLookup(...)` error | `ZegelResolver` |
| `0xf4d4d2f8` | `resolveWithProof(bytes,bytes)` callback | `ZegelResolver` |
| `0x13b2642c` | `FEATURE_SEALED_ENVELOPE`, namespaced to us | `ZegelResolver` |
| `0x51f67f40` | ENSv2 `IRegistry` | `ZegelIssuerRegistry` |
| `0x8f452d62` | ENSv2 `IEnhancedAccessControl` | `ZegelIssuerRegistry` |

ENSIP-22 is a draft and reserves no feature ids for third parties, so `FEATURE_SEALED_ENVELOPE` is
namespaced rather than borrowed from a registry that does not exist yet.

The mainnet `PublicResolver` (`0xF29100983E058B709F3D539b0c765937B804AC15`) answers
`supportsInterface(0xecbfada3)` with **false** — verified live. `data()` exists only on ENSv2's
Sepolia resolvers or on your own. That is why this resolver exists.

---

## `ZegelResolver`

Envelope encoding is the **canonical-JSON serialisation of `zegel.envelope.v1`, as UTF-8 bytes**
(sorted keys, no whitespace — the same encoding `@zegel/sdk`'s `canonicalDigest` hashes). The contract
never parses it, so the schema can move without a redeploy.

### The asymmetry the gateway must respect

CCIP-Read substitutes the callback's return data for the **original** call's return data. Both entry
points return `bytes`, but they mean different things:

| Query | `callData` prefix | The gateway's `result` must be |
|---|---|---|
| `data(node, key)` | `0xecbfada3` | the envelope bytes |
| `resolve(name, data)` | `0x9061b923` | `abi.encode(envelope)` |

Getting this wrong produces a response that verifies and then decodes to garbage. The gateway tells
the two apart by the leading selector of `callData`.

### Gateway response format

`abi.encode(bytes result, uint64 expires, bytes signature)`, where `signature` is 65 bytes over

```
keccak256(0x1900 ‖ resolver ‖ expires ‖ keccak256(callData) ‖ keccak256(result))
```

EIP-191 version `0x00`, "intended validator". Low-`s` only: the mirrored signature is refused so a
response has exactly one representation.

### Administration

`setSigner(address,bool)` · `setGatewayUrls(string[])` · `setEnvelope(bytes32,bytes)` (on-chain
fallback, bypasses the gateway for that node) · two-step `transferOwnership` / `acceptOwnership`.

Gateway URLs are public on chain — `cast call <resolver> "gatewayUrls()(string[])"` reads them.
**Never put an API key in one.**

---

## `ZegelAnchor`

No owner, no admin. Anyone may anchor an unclaimed id; only the address that claimed it may re-anchor
or revoke. Squatting an id is possible and harmless — the squatter's commitment will not match the
real evidence, and `verify` reports that.

```solidity
function anchor(bytes32 referenceId, bytes32 commitment, uint64 expiresAt) external;
function revoke(bytes32 referenceId, string calldata reason) external;
function isValid(bytes32 referenceId) external view returns (bool);
function verify(bytes32 referenceId, bytes32 commitment) external view returns (Status);
```

`Status` is `NeverAnchored | Valid | Expired | Revoked | CommitmentMismatch`. Lifecycle outranks
content: a revoked reference reads as `Revoked` even when the caller also brought the wrong
commitment, because the reader's next action is the same either way.

**`CommitmentMismatch` is the negative control.** A claim set with one number edited hashes to
something else, and the anchor says so without anyone decrypting anything.

Revocation is a one-way door. `anchor` refuses to touch a revoked id, so an issuer cannot quietly
rehabilitate a withdrawn reference; a new reference needs a new id. This is the property the
invariant suite exists to defend.

---

## `ZegelIssuerRegistry`

An ENSv2 subregistry (`IRegistry`) with a faithful Enhanced Access Control implementation on top.

### Four-level `resource(node, part)` scoping

`resource(node, part) = uint256(keccak256(abi.encode(node, part)))`. Zeroing either half widens the
grant:

| resource | grants |
|---|---|
| `(0, 0)` | any name, any record |
| `(0, part)` | any name, one record type |
| `(node, 0)` | one name, any record |
| **`(node, part)`** | **one name, one specific record** |

`resource(0, 0)` is **not** `ROOT_RESOURCE`. Root is the literal id `0`, OR'd into every check;
`resource(0, 0)` is a hashed registry-wide wildcard that root can hand out and take back without
surrendering root itself. `test_RegistryWideGrantIsNotRoot` pins the distinction.

The product use: an issuing agent gets `ROLE_SET_DATA` on
`resource(nodeOf(acme), dataPart("zegel.envelope.v1"))` and nothing else. It cannot change the
resolver, cannot touch a second key, cannot touch a second name, and cannot delegate onward — it got
the role but not its admin half.

### Role model

Nybble-packed, ENSv2's numbering. 32 roles in the low 128 bits at 4 bits each, each role's admin
128 bits higher. The spare 3 bits of each nybble are a per-resource assignee counter, which is why a
role saturates at 15 holders — enforced structurally, not by comparison.

`ROLE_REGISTRAR 1<<0` · `ROLE_UNREGISTER 1<<12` · `ROLE_SET_SUBREGISTRY 1<<20` ·
`ROLE_SET_RESOLVER 1<<24` · `ROLE_SET_DATA 1<<36`.

`ROLE_SET_DATA` is borrowed from ENSv2's `PermissionedResolverLib`, not from `RegistryRolesLib`'s
`ROLE_SET_URI`, which shares the same nybble. Records are what this registry scopes and it has no
`setUri`.

### Provable revocation

Two granularities:

1. `revokeRecordRoles(...)` — take back one grant, leave the rest.
2. `bumpEacVersion(...)` — `node` is derived from the entry's `eacVersionId`, so bumping it moves
   every resource belonging to the name and makes every previously granted role unreachable in one
   write, without enumerating anyone. The same call regenerates `tokenVersionId`, so the token id
   changes: `tokenId = canonicalId | tokenVersionId`, `canonicalId = tokenId ^ uint32(tokenId)`.

**Never cache a token id**, and never bind an external guardian to one either — bind it to the
resource, or it breaks quietly the first time a role changes.

The owner carries across a bump; every delegate does not. Records survive it — only permissions
reset. Revocation is "no more writes", not "unwrite".

---

## Addresses

### Deploy targets

| Contract | Chain | Constructor |
|---|---|---|
| `ZegelResolver` | Ethereum mainnet, 1 | `(owner, gatewayUrls[], signers[])` |
| `ZegelAnchor` | Base mainnet, 8453 | none |
| `ZegelIssuerRegistry` | Sepolia, 11155111 | `(root)` |

```bash
forge script script/DeployResolver.s.sol      --rpc-url mainnet --broadcast --verify
forge script script/DeployAnchor.s.sol        --rpc-url base    --broadcast --verify
forge script script/DeployIssuerRegistry.s.sol --rpc-url sepolia --broadcast --verify
```

Env: `ZEGEL_OWNER`, `ZEGEL_GATEWAY_SIGNER`, `ZEGEL_GATEWAY_URLS` (comma-separated),
`MAINNET_RPC_URL`, `BASE_RPC_URL`, `SEPOLIA_RPC_URL`, `ETHERSCAN_API_KEY`.

### ENS mainnet, verified live 2026-09-03

| | |
|---|---|
| ENSRegistry | `0x00000000000C2E074eC69A0dFb2997BA6C7d2e1e` |
| UniversalResolver | `0xED73a03F19e8D849E44a39252d222c6ad5217E1e` |
| PublicResolver | `0xF29100983E058B709F3D539b0c765937B804AC15` — no `0xecbfada3`, no `0x9061b923` |

Pointing a name at the resolver is a separate transaction by the name's owner:

```bash
cast send 0x00000000000C2E074eC69A0dFb2997BA6C7d2e1e \
  "setResolver(bytes32,address)" <namehash> <ZegelResolver>
```

### ENSv2 Sepolia, re-verified with `cast code` 2026-09-03

Every address below returned bytecode. `RootRegistry.getSubregistry("eth")` returned exactly the
`ETHRegistry` address quoted, and both registries answered `supportsInterface(0x51f67f40)` and
`supportsInterface(0x8f452d62)` with `true`.

| | | |
|---|---|---|
| RootRegistry | `0x8115186e8f2e0b0281e86ab91f0f48ba90364354` | ✅ code |
| ETHRegistry | `0xbdc85dd5b15d7ecb354cd7cb6f2c50b4f2c4f0e2` | ✅ code, `IRegistry` + EAC |
| ETHRegistrar | `0xa88553f454b77203b0d036a05c894d555eaaa2cc` | ✅ code |
| UniversalResolverV2 proxy | `0xeEeEEEeE14D718C2B47D9923Deab1335E144EeEe` | ✅ code |
| PermissionedResolver impl | `0x9eae5c2730a7dd16bdd1dee6421a1b91e3b0365e` | ✅ code, `0xecbfada3` = true |
| VerifiableFactory | `0x10dc6333cdfe1fcef624c6e0a8221b91804cd7ef` | ✅ code |
| LabelStore | `0x532cd0cc4ac0793d838f71a67d29b2d790d18777` | ✅ code |

> **These rotate on every full redeploy — four rotations in three months.** `DeployIssuerRegistry`
> re-checks `code.length` at broadcast time and refuses to deploy against an empty address, but check
> them yourself before a demo.

**One thing we could not verify:** `type(IEnhancedAccessControl).interfaceId` over the member list
published in the ENSv2 docs XORs to `0xa8c93479`, not the `0x8f452d62` the deployed registries
actually answer to. The live interface evidently has members beyond the documented set. We use the
on-chain value as a constant (`EAC_INTERFACE_ID`) rather than recompute it, and say so in the
contract. All eight EAC error selectors, by contrast, reproduce byte-for-byte from the documented
names and argument lists.

**ENSv2 privacy caveat, said before a judge says it:** `LabelStore` is an on-chain labelhash →
plaintext database. ENSv2 adds write-side access control and deletability, and zero cryptographic
privacy. Reads are fully public. `PermissionedResolver` is not read authorisation.

---

## Tests

```
test/ZegelResolver.t.sol            41  standards, offchain lookup, callback, admin, fuzz
test/ZegelAnchor.t.sol              23  lifecycle, the negative control, fuzz
test/ZegelAnchor.invariant.t.sol     3  invariants over anchor/revoke/hijack/time
test/ZegelIssuerRegistry.t.sol      53  IRegistry, four-level scoping, EAC mechanics, fuzz
                                   ---
                                   120
```

The adversarial cases worth naming:

- `test_RevertWhen_SenderIsNotThis` — `extraData` naming the UniversalResolver. This is the single
  most common bug in offchain resolvers: through the UR the client observes the UR as `sender`, and a
  callback that trusted `msg.sender`, or that trusted whoever assembled `extraData`, would accept
  responses minted for a contract it does not control.
- `test_RevertWhen_ReplayedAgainstDifferentNode` / `...DifferentKey` — a genuinely valid signed
  response, lifted onto another query. Fails through `callData` binding. Generalised in
  `testFuzz_QueryBindingHoldsAcrossNodes`.
- `test_RevertWhen_ResponseMintedForAnotherResolver` — same signer, different target address.
- `test_RevertWhen_SignatureExpired`, `test_ExpiryBoundaryIsInclusive` — good up to and including the
  expiry second, dead the next block.
- `test_RevertWhen_SignatureMalleable` — the mirrored `(r, n−s, v^1)` that a naive verifier accepts.
- `test_Verify_CommitmentMismatch` — **the negative control.** A tampered claim set against a live,
  unrevoked anchor.
- `invariant_RevokedNeverReturnsToValid` — 256 runs × 64 calls of interleaved anchoring, revocation,
  hijack attempts and time travel. `afterInvariant` asserts the run actually reached a revoked
  reference, so the invariant cannot pass vacuously.
- `test_BumpEacVersionInvalidatesEveryGrant` — two delegations at two different scoping levels, both
  ended by one write, neither enumerated.

`block-timestamp` lints are excluded in `foundry.toml`: every contract here is expiry-driven at
day scale, where a validator's few seconds of leeway is immaterial.
