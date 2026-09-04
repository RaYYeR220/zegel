# PROOF

Demo video: https://youtu.be/Iko5B5-Ato0

Every claim Zegel makes, with a link you can open and a command you can run.

Everything below was re-run against live chains and live hosts on **2026-09-04**. Where a
figure came from a one-time measurement rather than a repeatable read, it says so in place.

Public RPCs used, all keyless:
`https://ethereum-rpc.publicnode.com` · `https://mainnet.base.org` ·
`https://ethereum-sepolia-rpc.publicnode.com` · `https://api.mainnet-beta.solana.com` ·
`https://rpc.gnosischain.com`

---

## 1. The negative controls

A green check that cannot go red is worthless. These four go red, on demand, against production.
The first three are one command each.

### 1.1 The Base anchor answers `4 (CommitmentMismatch)` on one altered hex digit

`ZegelAnchor.verify(bytes32,bytes32)` is selector `0x4e8fee00`. Three `eth_call`s, no wallet,
no key, no library:

```bash
# 1 — Valid
curl -s https://mainnet.base.org -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"eth_call","params":[{"to":"0xbcB85eCdeF23a11D5015b260cC4eDCc0c250f42e","data":"0x4e8fee00a5a4d829143280bd2ad24c33c9f94da4e37cf6d5d29ba1acef4c9b2a96f51a9fce99fc040a03fb82d617b61fce60933590049b003b7b5b989f7c3681f1b3fca5"},"latest"]}'

# 4 — CommitmentMismatch (final hex digit …fca5 -> …fca6)
curl -s https://mainnet.base.org -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"eth_call","params":[{"to":"0xbcB85eCdeF23a11D5015b260cC4eDCc0c250f42e","data":"0x4e8fee00a5a4d829143280bd2ad24c33c9f94da4e37cf6d5d29ba1acef4c9b2a96f51a9fce99fc040a03fb82d617b61fce60933590049b003b7b5b989f7c3681f1b3fca6"},"latest"]}'

# 0 — NeverAnchored (unknown reference id)
curl -s https://mainnet.base.org -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"eth_call","params":[{"to":"0xbcB85eCdeF23a11D5015b260cC4eDCc0c250f42e","data":"0x4e8fee000000000000000000000000000000000000000000000000000000000000000000ce99fc040a03fb82d617b61fce60933590049b003b7b5b989f7c3681f1b3fca5"},"latest"]}'
```

| Call | Returned |
|---|---|
| `verify(referenceId, correct commitment)` | `0x…01` — **1, Valid** |
| `verify(referenceId, one hex digit changed)` | `0x…04` — **4, CommitmentMismatch** |
| `verify(unknown referenceId, commitment)` | `0x…00` — **0, NeverAnchored** |
| `isValid(referenceId)` | `true` |
| `issuerOf(referenceId)` | `0x7C7625c81D933fA006bBd3eE2601C8eA8251a14B` |

The answer comes from Base mainnet, not from any Zegel code. The same two envelopes ship as
fixtures so the check can be driven from the CLI — see [JUDGES.md](./JUDGES.md) step 6.

### 1.2 The Solana verifier answers `COMMITMENT-MISMATCH`

Read-only, no keypair. From `zegel/solana`:

```bash
node src/cli/index.ts verify --cluster mainnet-beta \
  --issuer  BW2UCEkixRcSAAsfUEKe2YZMXLNUMwxZqBpCGBEQ7tD9 \
  --subject BW2UCEkixRcSAAsfUEKe2YZMXLNUMwxZqBpCGBEQ7tD9 \
  --reference-id 0xa5a4d829143280bd2ad24c33c9f94da4e37cf6d5d29ba1acef4c9b2a96f51a9f \
  --commitment   0xce99fc040a03fb82d617b61fce60933590049b003b7b5b989f7c3681f1b3fca6   # …fca5 -> …fca6
```

| Input | Status | Exit |
|---|---|---|
| correct commitment | `VALID` | 0 |
| one hex digit changed in the commitment | **`COMMITMENT-MISMATCH`** | 2 |
| one hex digit changed in the reference id | **`REFERENCE-MISMATCH`** | 2 |
| a subject with no attestation | **`NOT-FOUND`** | 2 |
| no `--commitment` at all | `VALID`, and it says the contents were not checked | 0 |

`NOT-FOUND` is reported with its own caveat attached: public RPCs prune history, so an absent
account is not proof one never existed.

### 1.3 Swarm returns 404 to an un-granted reader while the publisher reads 200

Same reference, same second, two readers. This is the one that shows the bytes are present and
the failure is **access**, not absence.

```bash
REF=455c6296d5c84827a74be288d3b527f0ebe889246f3a49ac36a50dc78bd3337b   # tier 1, from the live envelope
HIST=51c29bff05cba8f8b58e8db39e02e9803acdbc34be9125d0eda49b296dc597fe
PUB=02ccb978ca8962cfaaba490b834894480e10be09633bfacfba8853dd4b81799d1f

# no credentials
curl -i http://127.0.0.1:1633/bytes/$REF

# publisher, with the three ACT coordinates
curl -i -H "swarm-act: true" -H "swarm-act-publisher: $PUB" \
        -H "swarm-act-history-address: $HIST" http://127.0.0.1:1633/bytes/$REF
```

| Reader | Result |
|---|---|
| no credentials | **HTTP 404**, 36 bytes, `{"code":404,"message":"Not Found"}` |
| publisher, with `swarm-act` + publisher key + history address | **HTTP 200**, **994 bytes**, the tier-1 claim set |

Those 994 bytes are the commitment's preimage: hash them and you get the value anchored on Base
and carried in the Solana attestation — see §7.3.

### 1.4 The evidence-integrity control, which caught a failure of ours

The commitment is a hash of the *claim set*. It does not cover the raw upstream bodies inside
tier 2. Those are covered by a per-source digest, and `verifyClaims` re-hashes every one of them:

```
verifyClaims ok: true  | mismatches: 0        # tier 2 as published, read back through ACT
```

Change one character inside one recorded body and re-run:

```
verifyClaims ok: false | mismatches: 1
  - source 0 (GET /2/wallet/positions-history): digest 0x9fc92005…f9cbbe does not match its
    body (0xdb55d3de…0da45)
```

**This control caught a real integrity failure in our own first publication.** See §9.

---

## 2. The reference under verification

The live reference published under `zegel.eth`:

| Field | Value |
|---|---|
| `referenceId` | `0xa5a4d829143280bd2ad24c33c9f94da4e37cf6d5d29ba1acef4c9b2a96f51a9f` |
| `commitment` | `0xce99fc040a03fb82d617b61fce60933590049b003b7b5b989f7c3681f1b3fca5` |
| `derivationId` | `0xcd0528ad537c9547d4c9c687165e65a67df2a7582635f4b8f236acb2405415fa` |
| issued | 2026-09-04T09:50:10.867Z |
| expires | 2026-12-03T09:50:10.867Z (envelope) · 2026-12-03T09:50:36Z (anchor) |
| issuer / subject wallet | `0x7C7625c81D933fA006bBd3eE2601C8eA8251a14B` |

Issuing requires an EIP-191 control-proof signature over the reference id, so a reference can
only be issued for a wallet whose key the issuer holds. This one is ours.

A first reference, superseded by the one above and still live on Base, is what the shipped CLI
fixtures address:

| Field | Value |
|---|---|
| `referenceId` | `0x644e1b8b170a18d7793dc3d266ecab544e3b9d9dca3619e7e8f2a678de4c30ce` |
| `commitment` | `0xe2fb17f0870b418e2799338e1ef8781aff3b6a2d9ef318ec20a7e788dd86c574` |
| anchor tx | [`0xe35a44bd…d243b6`](https://basescan.org/tx/0xe35a44bd37ee922d719728dcc24e1e046dc98663bf406b9bb722202188d243b6) — Base block 50,844,621, 91,636 gas |
| `verify` today | **1, Valid** |

---

## 3. Ethereum mainnet — the name and the resolver

### 3.1 `zegel.eth`

| | |
|---|---|
| commit tx | [`0xf1e28c52…3f109d`](https://etherscan.io/tx/0xf1e28c520e3e843d47ecfad0460b57c6b0ffe8e36788386dfbe30535263f109d) — block 25,899,869, **44,206 gas** |
| register tx | [`0xef1d1d55…8ce164`](https://etherscan.io/tx/0xef1d1d55928b1125f72e6c6540870ae62dc38b3a7fa7b69f61b6dff7828ce164) — block 25,899,886, 144,297 gas, **0.002099590609580475 ETH** paid, 1 year |
| ENS node (namehash) | `0x16a79596bc3e4f83503f87e3113fbf0ab994d16627eefff4ab039e46651cd7e7` |
| BaseRegistrar token id (labelhash `"zegel"`) | `0xb6a03b9bcf8cd2f83b4e835cfe3d94ebabeaa3d9ef770820f47cbbb2d8481598` |
| owner | [`0x7C7625c8…51a14B`](https://etherscan.io/address/0x7C7625c81D933fA006bBd3eE2601C8eA8251a14B) |

```bash
cast call 0x00000000000C2E074eC69A0dFb2997BA6C7d2e1e "resolver(bytes32)(address)" \
  0x16a79596bc3e4f83503f87e3113fbf0ab994d16627eefff4ab039e46651cd7e7 \
  --rpc-url https://ethereum-rpc.publicnode.com
# 0x479b0E18B3cE76C62402622e654bc235B1B529d1
```

**The live `ETHRegistrarController` takes a struct.** The registration went through selector
`0xef9c8805` = `register((string,address,uint256,bytes32,address,bytes[],uint8,bytes32))`. The
eight-positional-argument signature that tutorials and SDK samples still show,
`register(string,address,uint256,bytes32,address,bytes[],bool,uint16)` = `0x74694a2b`, **does
not appear anywhere in the deployed runtime bytecode** — grep the output of
`cast code 0x59E16fcCd424Cc24e280Be16E11Bcd56fb0CE547` for `74694a2b` and you get nothing.
`reverseRecord` is a `uint8` bitmask, not a `bool`; the registration passed `0`.

### 3.2 `ZegelResolver`

| | |
|---|---|
| address | [`0x479b0E18B3cE76C62402622e654bc235B1B529d1`](https://etherscan.io/address/0x479b0E18B3cE76C62402622e654bc235B1B529d1) |
| deploy tx | [`0x2af1e960…3526a1`](https://etherscan.io/tx/0x2af1e960f4beae765b41c353ba22f51ce5e2fa7641b3609747ce248d063526a1) — block 25,900,374, 2,068,450 gas, 0.0001041955 ETH |
| `setResolver` tx | [`0xdf2b74fc…33f5dc26`](https://etherscan.io/tx/0xdf2b74fc016378de23db36b435ef7ac45b8597ae52068db70fa6637533f5dc26) — block 25,900,382, 31,215 gas |
| runtime code | 8,604 bytes |

Live reads:

| Call | Answer |
|---|---|
| `supportsInterface(0x9061b923)` ENSIP-10 | `true` |
| `supportsInterface(0xecbfada3)` ENSIP-24 `data()` | `true` |
| `supportsInterface(0x582de3e7)` ERC-7996 | `true` |
| `supportsFeature(0x13b2642c)` `FEATURE_SEALED_ENVELOPE` | `true` |
| `supportedDataKeys(node)` | `["zegel.envelope.v1"]` |
| `gatewayUrls()` | `["https://zegel-gateway.vercel.app/v1/{sender}/{data}"]` |
| `signers(0x1050f2b60e25F59bF367789cca833496122AC110)` | `true` |
| `owner()` | `0x7C7625c81D933fA006bBd3eE2601C8eA8251a14B` |

For contrast, the mainnet `PublicResolver` `0xF29100983E058B709F3D539b0c765937B804AC15` answers
`supportsInterface(0xecbfada3)` and `supportsInterface(0x9061b923)` with **false**. `data()` is
not available on the default ENS resolver, which is why this one exists.

### 3.3 The CCIP-Read round trip, done by hand

One `eth_call` produces the `OffchainLookup` revert; decoding it shows the whole mechanism:

```bash
cast call 0x479b0E18B3cE76C62402622e654bc235B1B529d1 \
  "data(bytes32,string)" \
  0x16a79596bc3e4f83503f87e3113fbf0ab994d16627eefff4ab039e46651cd7e7 "zegel.envelope.v1" \
  --rpc-url https://ethereum-rpc.publicnode.com
```

The revert data decodes as `OffchainLookup(address,string[],bytes,bytes4,bytes)`:

```
sender            0x479b0E18B3cE76C62402622e654bc235B1B529d1     <- the RESOLVER, not the caller
urls              ["https://zegel-gateway.vercel.app/v1/{sender}/{data}"]
callData          0xecbfada3…                                    <- data(node, "zegel.envelope.v1")
callbackFunction  0xf4d4d2f8                                      <- resolveWithProof(bytes,bytes)
extraData         …479b0e18b3ce76c62402622e654bc235b1b529d1…      <- this resolver's own address
```

That first line is the entire access-control argument in one field: **the gateway is told which
resolver asked, never who is reading.** Fetch the URL, feed the response back through
`resolveWithProof`, and the contract verifies the signature and returns the envelope. Measured
today: gateway leg **1,765 ms** cold, on-chain callback leg **210 ms**. Full transcript in
[JUDGES.md](./JUDGES.md) step 3.

---

## 4. Base mainnet — the commitment anchor

| | |
|---|---|
| `ZegelAnchor` | [`0xbcB85eCdeF23a11D5015b260cC4eDCc0c250f42e`](https://basescan.org/address/0xbcB85eCdeF23a11D5015b260cC4eDCc0c250f42e) |
| deploy tx | [`0x7c32343d…f5d87d`](https://basescan.org/tx/0x7c32343d11f3c74dd4d22f48ad15172d80396aabc9e8808666fa3803a2f5d87d) — block 50,843,365, 625,768 gas, **0.0000032853 ETH** |
| runtime code | 2,674 bytes |
| anchor tx (current reference) | [`0x3ded6f96…851c74`](https://basescan.org/tx/0x3ded6f96f9e72ead5fda68ac59d34f653286775f76286b98500389c0ab851c74) — block 50,863,046, 91,624 gas, 0.0000004810 ETH |
| anchor tx (first reference) | [`0xe35a44bd…d243b6`](https://basescan.org/tx/0xe35a44bd37ee922d719728dcc24e1e046dc98663bf406b9bb722202188d243b6) — block 50,844,621, 91,636 gas |
| `MAX_REASON_BYTES()` | `256` |

No constructor arguments, no owner. Anchoring is permissionless and a reference id belongs to
whoever claimed it first; squatting an id is possible and harmless, because the squatter's
commitment will not match any real evidence and `verify` says so.

Negative control: §1.1.

---

## 5. Solana mainnet — the portable attestation

All three anchors describe the same commitment `0xce99fc04…fca5`.

| | |
|---|---|
| SAS program | `22zoJMtdu4tQc2PzL74ZUT7FrwgB1Udec8DdW4yw4BdG` |
| attestation | [`36A3Fyeid2fauHVs1atAvc8YFvt7tvDSMqofZaeYYQbM`](https://solscan.io/account/36A3Fyeid2fauHVs1atAvc8YFvt7tvDSMqofZaeYYQbM) |
| issue tx | [`35DCZai3…LCN3LEm`](https://solscan.io/tx/35DCZai3bBRZpg24AhpSDFifH4f14b5vvnEZGzu7Y1WuBWbT8Bop36hHc5jZfwc3NqzmcgcZcjm6vNRDoLCN3LEm) — slot 444,218,520, fee 13,000 lamports |
| issuer setup tx | [`9BnwfoeV…1Fq6F`](https://solscan.io/tx/9BnwfoeVQJx6UkXUcoXwb3VHJCtL5VzFr7TrmA2K3uy94cEyGjit7cct5sgFpwFyJZ55VRRSPAPiYTNkDx1Fq6F) — slot 444,218,509 |
| credential `"zegel"` | [`E71jA1xf49cCJFVcvDxhqm8eDDF6mcf8VFgoCaWfpSen`](https://solscan.io/account/E71jA1xf49cCJFVcvDxhqm8eDDF6mcf8VFgoCaWfpSen) |
| schema `"reference"` v1 | [`GpmsvJCNeKBkuwm25vY9vjzh89ojaqCiNActrZAq1EKC`](https://solscan.io/account/GpmsvJCNeKBkuwm25vY9vjzh89ojaqCiNActrZAq1EKC) — not paused |
| schema group mint | [`H8LCwFpia1QvwRH3eZsNJg9731nRWPpQ3qbK3rJmKKua`](https://solscan.io/account/H8LCwFpia1QvwRH3eZsNJg9731nRWPpQ3qbK3rJmKKua) |
| attestation mint | [`4q5SUtLBMRZztPTHdHK3QdDCjyPoezUiKpBdTpvvjtFq`](https://solscan.io/account/4q5SUtLBMRZztPTHdHK3QdDCjyPoezUiKpBdTpvvjtFq) |
| subject token account | [`EmZ7C7a8KY1DqGvqH9yEAsCbrioQAXpB6zdTtwKvcSLG`](https://solscan.io/account/EmZ7C7a8KY1DqGvqH9yEAsCbrioQAXpB6zdTtwKvcSLG) — balance 1 |
| subject / nonce | `BW2UCEkixRcSAAsfUEKe2YZMXLNUMwxZqBpCGBEQ7tD9` (a Solana pubkey; also the issuer authority here) |

**The attestation account carries the commitment verbatim.** Fetch it and read the bytes:

```bash
curl -s https://api.mainnet-beta.solana.com -H 'content-type: application/json' \
 -d '{"jsonrpc":"2.0","id":1,"method":"getAccountInfo","params":["36A3Fyeid2fauHVs1atAvc8YFvt7tvDSMqofZaeYYQbM",{"encoding":"base64"}]}'
```

290 bytes, owned by the SAS program. Its 117-byte `data` field decodes against the schema fields
`referenceId, commitment, expiresAt, derivationId, tierCount` to:

```
referenceId   a5a4d829143280bd2ad24c33c9f94da4e37cf6d5d29ba1acef4c9b2a96f51a9f
commitment    ce99fc040a03fb82d617b61fce60933590049b003b7b5b989f7c3681f1b3fca5
expiresAt     0x6b113b6c = 1796291436 = 2026-12-03T09:50:36Z
derivationId  cd0528ad537c9547d4c9c687165e65a67df2a7582635f4b8f236acb2405415fa
tierCount     2
```

**Soulbound by construction**, read live off the mint (`getAccountInfo … jsonParsed`):
`nonTransferable` extension present; `permanentDelegate`, `mintCloseAuthority`, `freezeAuthority`
and `mintAuthority` are all the SAS program PDA `HngMQFF6Yoqj9VqA31r43HQsnuYZ6BxopRWQLQAS6zk`;
supply 1, decimals 0. The program can burn and close without the subject signing; the subject
cannot move the token away from where a verifier looks.

**Not revoked** — the attestation is left live for judging. Revocation closes the account; the
rent it would return is 2,647,194 lamports (attestation) + 5,889,690 lamports (mint) =
**0.008536884 SOL**, read live off the two accounts.

Negative controls: §1.2.

---

## 6. Swarm — postage, sealing, grant and revoke

### 6.1 Postage batches, bought on Gnosis mainnet

Both purchases are on chain against the Swarm `PostageStamp` contract
`0x45a1502382541cd610cc9068e88727426b696293`, paid by the publisher node's Gnosis account
`0x376DfE748C5b65ea04Cd807149E3E53e361288c8`.

| Batch | Tx | Depth | Amount / chunk | Total |
|---|---|---|---|---|
| `a3da0bac8467c95b021b4c1b918d48c0181678aef7aa5cd966cc33d1f63144c3` | [`0x929fd732…ce5823`](https://gnosisscan.io/tx/0x929fd732a307c5fdd0f0c9a4df6484eff4c8f19e45c05df730b248f64cce5823) — block 48,066,684, 458,855 gas | 17 (bucket 16, mutable) | 11,618,933,760 | 1,522,916,885,790,720 PLUR = **0.152291688579072 xBZZ** |
| `ce8d3c672a4fb7d30fe5dd6d01562285d8a3353b3d5138187aea6f2f3d189f00` | [`0xebc00104…facae9`](https://gnosisscan.io/tx/0xebc001046579fbed46e4b81c9ff421bb68370ba5c33349491635a2c7b3facae9) — block 48,068,208, 399,936 gas | 19 (bucket 16, mutable) | 8,722,909,440 | 4,573,316,744,478,720 PLUR = **0.457331674447872 xBZZ** |

Every field above is read from the `BatchCreated` event topic and data, not from a node. The
batch id is the event's indexed topic.

The price used for the purchase was read live from `GET /chainstate` (`currentPrice: 84049`)
rather than hardcoded. Remaining TTL and `usable` are node-local, time-varying readings and are
not asserted here; query your own node's `GET /stamps` for the current value.

### 6.2 The two Bee nodes

| | Publisher | Grantee |
|---|---|---|
| version | Bee 2.8.2 (`2.8.2-7e703f49`) | Bee 2.8.2 (`2.8.2-7e703f49`) |
| API | `127.0.0.1:1633` | `127.0.0.1:1643`, unfunded ultra-light |
| ACT public key | `02ccb978ca8962cfaaba490b834894480e10be09633bfacfba8853dd4b81799d1f` | `03c2694c2b58816f61b1437bd4f58b84b06cd52f80c3fb5dd7dc34adcdd7314cea` |
| overlay | `d182c57780d25ef2bc1bb41ebbcb8960de74e2e7caf126366bde3640371d1ea0` | `d7b9f3f833f611d30abc454b0e885c452be2f9719acb41ba290fe4b10e6a7429` |
| Gnosis address | `0x376DfE748C5b65ea04Cd807149E3E53e361288c8` | `0xa11b406c8866aafdddf334d06d51c0a00c9a6aed` |

Reading costs nothing, which is why an unfunded ultra-light node is enough to be a grantee.

### 6.3 The grant / read / revoke transcript

Grantee list created on the publisher node:

```
granteeListRef  2f3161f5945ef92583ed8be33dddadad04eebd4345abc780f78907113387b8e484c0dcf54bd4575ed67652001728fcfc2c9400c20a13d0dac26c7642f46e7e25
historyRef      feb9f610d63c93af32ef79f4dcd542d13ce3923824b602f01d5a993bc3cd4dd8
payload v1      8397a6cd42a1c6d1a8a614cac5b943da422e0721a61d3ba736c48fa963e32ec1
```

Publisher then revoked the grantee (`PATCH /grantee/{ref}` with `{"revoke":[…]}`) and sealed a
second version under the new history:

```
granteeListRef  3361b5eb1b3accdd0cccc3b381cd1a498d908d12c1b8b773831d1cf1cf4a1ed8befdfa9eff6e889af3bc61b330bba8fbea3e870b420b3c201be3ba1f8a48ae80
historyRef      74ac3c2726f7ddc6c31138a1ab6b9738a1c1deced8f6b70b99179980c314e864
payload v2      0962a5d59ae3ac70ddf069ddfd36e64c8ed1532479b52b4a4eadab396712a596
```

All five reads below were re-run on 2026-09-04 against the two running nodes:

| Read | Result |
|---|---|
| **revoked grantee reads v2** | **HTTP 404**, `{"code":404,"message":"act or history entry not found"}` |
| publisher reads v2 | **HTTP 200**, 116 bytes — v2 exists and is intact, so the grantee's failure is *access*, not absence |
| no credentials at all, v2 | **HTTP 404**, 36 bytes, `{"code":404,"message":"Not Found"}` |
| no credentials at all, v1 | **HTTP 404**, 36 bytes, `{"code":404,"message":"Not Found"}` |
| **revoked grantee reads v1** (already granted) | **HTTP 200**, 104 bytes |

The last row is shown on purpose. **Revocation is forward-only.** It cuts a reader off from every
future version and cannot retract what they already hold. A reference system that claimed
otherwise would be lying.

The two 404 bodies differ. Someone holding the history address — one of the three ACT
coordinates — can tell "revoked" from "never existed". Indistinguishability holds against
someone holding only the reference, which is the threat model that matters, and the gap is
stated rather than papered over.

ACT grantee patches are rate-limited to roughly one per second: Bee keys each history version on
the wall-clock second, so two writes inside one second collide. The client serialises them behind
a 1.1 s floor.

---

## 7. The published reference, end to end

### 7.1 The envelope, from the Swarm feed

The feed topic is `keccak256(utf8("zegel.envelope.v1") ‖ node)`. Nothing secret goes into it, so
anyone holding the name can recompute it and check the gateway against the feed directly:

```bash
curl -s https://api.gateway.ethswarm.org/feeds/2aF75dAb9634c389c5aAdDa4D74fcdc944c83218/44929537419c8793bbd340f367bb896ef229032630b19b8f949152e9d23a2d11
```

| | |
|---|---|
| feed owner | `0x2aF75dAb9634c389c5aAdDa4D74fcdc944c83218` |
| topic | `0x44929537419c8793bbd340f367bb896ef229032630b19b8f949152e9d23a2d11` |
| envelope | **1,062 bytes**, sha256 `0x82442b8513a9cc88fb338133758fe9c67ae8d970f8049dacb78a4424100721b5` |
| feed index | `0000000000000001` (the second update — see §9) |
| feed update | `a307c9170ea1ebe4acb148cd0a5260398e2a474d5a182400574ce2417f0eb14f` |

The envelope names two sealed tiers and one anchor, and contains no address:

```json
{"anchors":{"base":{"chainId":8453,"contract":"0xbcB85eCdeF23a11D5015b260cC4eDCc0c250f42e",
 "txHash":"0x3ded6f96f9e72ead5fda68ac59d34f653286775f76286b98500389c0ab851c74"}},
 "commitment":"0xce99fc040a03fb82d617b61fce60933590049b003b7b5b989f7c3681f1b3fca5",
 "expiresAt":"2026-12-03T09:50:10.867Z","issuedAt":"2026-09-04T09:50:10.867Z",
 "referenceId":"0xa5a4d829143280bd2ad24c33c9f94da4e37cf6d5d29ba1acef4c9b2a96f51a9f",
 "revocationHint":{"chainId":8453,"contract":"0xbcB85eCdeF23a11D5015b260cC4eDCc0c250f42e"},
 "schema":"zegel.envelope.v1","tiers":[
  {"actHistoryAddress":"51c29bff05cba8f8b58e8db39e02e9803acdbc34be9125d0eda49b296dc597fe",
   "actPublisher":"02ccb978ca8962cfaaba490b834894480e10be09633bfacfba8853dd4b81799d1f",
   "swarmRef":"455c6296d5c84827a74be288d3b527f0ebe889246f3a49ac36a50dc78bd3337b","tier":1},
  {"actHistoryAddress":"51c29bff05cba8f8b58e8db39e02e9803acdbc34be9125d0eda49b296dc597fe",
   "actPublisher":"02ccb978ca8962cfaaba490b834894480e10be09633bfacfba8853dd4b81799d1f",
   "swarmRef":"056a12d34f7b48129b4922d9fe73a0cbaed743361c2e761229ba8bc35bb38232","tier":2}]}
```

The byte-identical document comes back through mainnet CCIP-Read (§3.3), which is what closes
the loop between the ENS name and the Swarm feed.

### 7.2 The sealed tiers

| Tier | Swarm reference | Read back through ACT |
|---|---|---|
| 1 — claims | `455c6296d5c84827a74be288d3b527f0ebe889246f3a49ac36a50dc78bd3337b` | **994 bytes**, `zegel.claims.v1` |
| 2 — full evidence | `056a12d34f7b48129b4922d9fe73a0cbaed743361c2e761229ba8bc35bb38232` | **254,770 bytes**, `zegel.bundle.v1` |

Both under the same ACT history `51c29bff05cba8f8b58e8db39e02e9803acdbc34be9125d0eda49b296dc597fe`.

### 7.3 The commitment reproduces from the tier-1 bytes

`sha256` over the canonical JSON encoding of the tier-1 claim set — sorted keys, no whitespace —
is the commitment anchored on Base and carried in the Solana attestation:

```
canonical bytes  994
sha256           0xce99fc040a03fb82d617b61fce60933590049b003b7b5b989f7c3681f1b3fca5
```

For this claim set the canonical encoding is byte-identical to the stored object, so
`sha256` of the raw 994 bytes gives the same value.

### 7.4 The claim set says less than it could, on purpose

Tier 1 as published: schema `zegel.claims.v1`, **three claims**, and:

- no `actual` values anywhere — statements assert the threshold, never the measured number;
- no wallet address.

```
[PASS] realized-pnl-usd
[fail] closed-position-cycles
[fail] wallet-age-days
```

The subject wallet was one day old at issue time, so **only 3 of the 10 claim specs could be
computed at all**. The other seven were **omitted entirely** rather than defaulted to a failed
threshold. A reference that renders "no data" as "0 trades, failed" is inventing information.

### 7.5 The evidence bundle, re-verified

Tier 2 read back through ACT and passed to the project's own `verifyClaims`:

```
schema zegel.bundle.v1 | sources 12 | claims 3
bundle derivationId  0xcd0528ad537c9547d4c9c687165e65a67df2a7582635f4b8f236acb2405415fa
build  DERIVATION_ID 0xcd0528ad537c9547d4c9c687165e65a67df2a7582635f4b8f236acb2405415fa
unavailable sources: 1 — index 10, GET /2/wallet/defi-positions, HTTP 500
verifyClaims ok: true | mismatches: 0
```

12 live Mobula sources collected, **one recorded `unavailable` with its status and no body, and
zero claims derived from it.** The remaining 11 bodies each re-hash to the digest stored beside
them. Tamper with one and the check fails — §1.4.

### 7.6 The derivation, reproducible offline

`packages/evidence/test/fixtures/bundle-evm.json` is a bundle recorded from
`demo-api.mobula.io` on 2026-09-03 for `0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045`
(vitalik.eth), 18 sources. Re-deriving from it, offline, on any machine:

```
verifyClaims ok: true  mismatches: 0
 [fail] realized-pnl-usd             actual=-12526.91
 [PASS] closed-position-cycles       actual=20
 [fail] win-rate                     actual=0.2
 [PASS] max-drawdown-usd             actual=12536.25
 [PASS] median-holding-period-days   actual=524.7487
 [PASS] trading-cost-ratio           actual=0.008687
 [PASS] mev-fee-share                actual=0
 [fail] risk-quality-ratio           actual=0.75
 [fail] position-concentration       actual=0.531317
 [PASS] wallet-age-days              actual=3993.54
claim set contains "actual": false
claim set contains the subject address: false
```

Four of ten fail. The wallet is a net loser over the window with a 20% win rate, and 75% of the
tokens it traded score below Mobula's 60/100 safety threshold. **Zegel reported that.** Claims
are derived from chain data, never declared, and a reference that only ever flatters its subject
is worth nothing to the person reading it.

---

## 8. Sepolia — ENSv2 Enhanced Access Control

`ZegelIssuerRegistry` is an ENSv2 `IRegistry` subregistry with a faithful EAC implementation.
It demonstrates the property ENSv1 cannot express: **one write invalidates every prior grant,
by construction, without enumerating anyone.**

| | |
|---|---|
| address | [`0xbcB85eCdeF23a11D5015b260cC4eDCc0c250f42e`](https://sepolia.etherscan.io/address/0xbcB85eCdeF23a11D5015b260cC4eDCc0c250f42e) |
| deploy tx | [`0xb1a944b6…57dee2`](https://sepolia.etherscan.io/tx/0xb1a944b67171d837038c70fb624d68a67713902290f28e0e67b8b7cf9457dee2) — block 11,633,188, 2,671,025 gas |
| runtime code | 11,904 bytes |
| `supportsInterface(0x51f67f40)` `IRegistry` | `true` |
| `supportsInterface(0x8f452d62)` EAC | `true` |

> The address is the same as `ZegelAnchor` on Base — same deployer, same nonce, different chain.
> Not a mistake, but say which chain you mean.

The run, in order:

| Step | Tx | Block / gas |
|---|---|---|
| `register("reference", …)` | [`0xd503fd3d…ea0212`](https://sepolia.etherscan.io/tx/0xd503fd3d037d712d5aae439a7b9aad3ce9191415b0d8da29d106607790ea0212) | 11,633,194 · 148,435 |
| `grantRecordRoles(tokenId, "zegel.envelope.v1", ROLE_SET_DATA, delegate)` | [`0x4fc65973…a671e3`](https://sepolia.etherscan.io/tx/0x4fc65973c4415e6d0c0b00ecf5399763657b4552d0f411c3112757c218a671e3) | 11,633,198 · 81,132 |
| `revokeRecordRoles(…)` — take back that one grant | [`0x289f6e4e…396f9c13`](https://sepolia.etherscan.io/tx/0x289f6e4e7ba72a9bfc92e3eb9c37822a24a912712d9df6fa3b8b7b88396f9c13) | 11,633,199 · 37,464 |
| `bumpEacVersion(tokenId)` — invalidate everything | [`0x23ec5ea7…f88f9171`](https://sepolia.etherscan.io/tx/0x23ec5ea707acb08d811a9045ccccbd017eb057aff07e3b907b150daef88f9171) | 11,633,202 · 103,325 |

Decoded from the `grantRecordRoles` calldata: `roleBitmap = 68719476736 = 1 << 36 =
ROLE_SET_DATA`, `key = "zegel.envelope.v1"`, `account = 0x1050f2b60e25F59bF367789cca833496122AC110`.
Exactly one record on exactly one name — not the resolver, not a second key, not a second name,
and not the admin half, so the delegate cannot pass it on.

### The token id regenerates, and that is the whole point

`nodeOf(canonicalId) = uint256(keccak256(abi.encode(canonicalId, eacVersionId)))`, and
`resource(node, part) = uint256(keccak256(abi.encode(node, part)))`. A role change bumps
`eacVersionId`, which moves the node, which moves every resource belonging to the name.

```
tokenId       before  …852352                       after  …852353
eacVersionId  before  0                             after  1
node          before  1641718334028270651325629696353464155975665015099548907323298103889743508943
node          after   31392348428936429954466606513404094411661241790949642453414447480943292625698
```

Both node values are reproducible offline from public data with `cast keccak`, and the second
one matches the live `nodeOf` read. The granted resource,

```
resource(node_before, dataPart("zegel.envelope.v1"))
  = 86129008636470594556066093187782773355003657944119562305574727051044596682222
```

is also reproducible offline and confirmed by a live `resource(…)` call.

Live state today:

```bash
cast call 0xbcB85eCdeF23a11D5015b260cC4eDCc0c250f42e \
  "hasRoles(uint256,uint256,address)(bool)" \
  86129008636470594556066093187782773355003657944119562305574727051044596682222 \
  68719476736 0x1050f2b60e25F59bF367789cca833496122AC110 \
  --rpc-url https://ethereum-sepolia-rpc.publicnode.com
# false
```

| Read | Answer |
|---|---|
| `hasRoles` at the granted resource | **false** — revoked |
| `hasRoles` at the post-bump resource | **false** — the bump did not silently re-grant |
| `getEntry(tokenId)` | `eacVersionId 1`, `tokenVersionId 1`, owner `0x7C76…a14B`, expiry 1820057746 (2027-09-04T11:35:46Z) |

The owner carries across a bump; every delegate does not. Records survive it — only permissions
reset. **Never cache a token id**, and never bind an external guardian to one.

ENSv2 addresses were re-checked with `cast code` before the deploy and again today; all seven
still hold bytecode. They rotate on every ENSv2 redeploy, so check them yourself before a demo.

| | | |
|---|---|---|
| RootRegistry | `0x8115186e8f2e0b0281e86ab91f0f48ba90364354` | code |
| ETHRegistry | `0xbdc85dd5b15d7ecb354cd7cb6f2c50b4f2c4f0e2` | code |
| ETHRegistrar | `0xa88553f454b77203b0d036a05c894d555eaaa2cc` | code |
| UniversalResolverV2 proxy | `0xeEeEEEeE14D718C2B47D9923Deab1335E144EeEe` | code |
| PermissionedResolver impl | `0x9eae5c2730a7dd16bdd1dee6421a1b91e3b0365e` | code |
| VerifiableFactory | `0x10dc6333cdfe1fcef624c6e0a8221b91804cd7ef` | code |
| LabelStore | `0x532cd0cc4ac0793d838f71a67d29b2d790d18777` | code |

---

## 9. The integrity failure we found in our own first publication

The app's verifier flagged the first published `zegel.eth` reference as **Refused**: 5 of 11
tier-2 sources no longer hashed to the digests recorded beside them.

The cause was ours. The first envelope was assembled with a throwaway Python canonicaliser that
dropped `null` members — matching the TypeScript encoder's treatment of `undefined`, which JSON
does not have — and formatted floats differently from `JSON.stringify`. The recorded bodies were
altered on their way into the seal, so their digests stopped matching.

**Every surface-level check still passed.** The claims re-derived, the commitment matched, and
the Base anchor read `Valid`. Only the digest-level re-derivation caught it. A verifier that had
checked the commitment alone would have accepted altered evidence, and nothing else in the
system would have noticed.

Re-issued through the shared `canonicalize()` — one encoder, no exceptions. That re-issue is the
reference documented throughout this file, and it is why the Swarm feed reads index
`0000000000000001` rather than `0`.

---

## 10. Live URLs

| | |
|---|---|
| App | **https://zegel-app.vercel.app** — `/` `/issue` `/access` `/verify`, all HTTP 200 |
| Gateway health | **https://zegel-gateway.vercel.app/health** — `{"status":"ok", …}` |
| Gateway CCIP-Read endpoint | `https://zegel-gateway.vercel.app/v1/{sender}/{data}` |

`/health` reports each dependency as a request made in that moment, including its own on-chain
cross-check:

```
signer              ok   signing as 0x1050f2b60e25F59bF367789cca833496122AC110
store               ok   Swarm feed 0x2aF75dAb…83218 via https://api.gateway.ethswarm.org, cached 15s
resolver-allowlist  ok   signing only for 0x479b0E18B3cE76C62402622e654bc235B1B529d1
name-ownership      skipped  the swarm-feed store is read-only, so publish authority is the feed key
resolver-onchain    ok   0x479b0E18…529d1 allowlists 0x1050f2b6…C110; 1 gateway URL(s) configured
```

An unconfigured dependency reports `skipped`, never `ok`. The gateway serves
`Access-Control-Allow-Origin: *`, as ENSIP-22 requires.

---

## 11. Tests

Re-run on 2026-09-04. Each package installs and tests standalone; run `pnpm install` inside the
package directory first.

| Package | Command | Result |
|---|---|---|
| `contracts` | `forge test` | **120 passed**, 0 failed, 0 skipped (4 suites) |
| `cli` | `pnpm test` | **178 passed**, 0 failed (10 files) |
| `gateway` | `pnpm test` | **118 passed**, 1 skipped (10 files) |
| `packages/evidence` | `pnpm test` | **98 passed**, 1 skipped (the fixture recorder) |
| `solana` | `pnpm test` | **89 passed**, 7 skipped (`devnet.integration`, needs a funded devnet keypair) |
| `packages/seal` | `pnpm test` | **83 passed** with a local Bee node running; 82 passed / 1 skipped without one |
| `packages/sdk` | `pnpm test` | **16 passed** |
| **Total passing** | | **702** |

Contract coverage over `contracts/src`: 99.04% lines, 100.00% functions, 94.92% branches.

Run them per package. A recursive `pnpm -r test` from the workspace root covers six of the seven
workspace projects — `app` has no test script, and `cli` and `contracts` are outside the
workspace — so it reports 404 of the 702 and is not the path to quote.

**A flake that was here and is now fixed.** `gateway/test/contract.test.ts > is rejected on chain once the response has expired` used to derive its expiry from the host clock. anvil's `block.timestamp` only advances when a block is mined, so a chain sitting a second behind wall time did not consider the response expired and the revert did not fire — it failed roughly one run in four. The expiry is now read from the chain's own latest block, and the test passed five consecutive runs. The contract was never at fault: `ZegelResolver` enforces `if (expires < block.timestamp) revert SignatureExpired(...)`, and `test_RevertWhen_SignatureExpired`, `test_ExpiryBoundaryIsInclusive` and `testFuzz_ExpiryIsEnforced` pin the same boundary deterministically with `vm.warp`.

The gateway suite includes a full ERC-3668 round trip against the real `ZegelResolver`: it
compiles the contract, deploys it to a local anvil, starts the gateway on a real port, writes
that port into the resolver's `gatewayUrls()`, and lets **viem** drive `OffchainLookup` → HTTP
fetch → `resolveWithProof` for both the `data()` and `resolve()` paths. It also asserts on-chain
rejection of a response lifted onto another name (`UnauthorizedSigner`), `extraData` naming the
UniversalResolver (`SenderMismatch`), an expired response (`SignatureExpired`), and a revoked
signer.

`cli/test/live.anchor.test.ts` asks the deployed `ZegelAnchor` the three questions in §1.1 and
asserts all three answers, including through a raw `eth_call` in the shape you would paste into
`curl`. Both live suites skip themselves when their hosts are unreachable, so an offline machine
does not produce a red build — and certainly not a green one by asserting less.

---

## 12. What is not verified here

- **Postage TTL and batch utilisation** are node-local, time-varying readings. The on-chain
  depth, per-chunk amount and total are asserted; remaining days are not.
- **Effective storage capacity per depth** (Swarm quotes ~112 MB for depth 19) is Swarm's own
  figure, not a measurement of ours. The naive ceiling of 2^19 × 4 KB is 2 GiB; the real number
  is lower because of bucket balancing, and we do not restate either as our own.
- **Resolution latency.** The two HTTP legs measured today are in §3.3. End-to-end wall-clock
  figures depend on the RPC, the CDN edge and the network, and are not a property of the system.
- **Historical resolver assignment.** Whether the `ETHRegistrarController` set an interim
  resolver when `register` was called with `resolver: address(0)` could not be re-checked: the
  registration receipt contains no `NewResolver` log from the ENS registry, and confirming the
  intermediate state needs archive access this repo does not assume. What is certain is that
  `setResolver` was required and was executed — tx `0xdf2b74fc…33f5dc26`.
- **Mobula demo-host availability.** `demo-api.mobula.io` rate-limits. A live scan run today
  recorded `GET /2/token/security` as `unavailable` with **HTTP 429**; the evidence package also
  records real 500s from `/2/wallet/analysis`, `/2/wallet/defi-positions` and `/1/wallet/history`.
  These are recorded as unavailable rather than filled in, so the same command can produce fewer
  claims on a different day. That is the design, not a flake.
