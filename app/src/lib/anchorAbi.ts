/**
 * `ZegelAnchor`, Base mainnet `0xbcB85eCdeF23a11D5015b260cC4eDCc0c250f42e`.
 *
 * Only the two writes are here; the reads live in `@zegel/sdk` and are done
 * server-side. Anchoring is permissionless and has no owner — a reference id
 * belongs to whoever claimed it first — so the only signature this contract ever
 * needs is the issuer's own.
 */
export const ANCHOR_WRITE_ABI = [
  {
    type: 'function',
    name: 'anchor',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'referenceId', type: 'bytes32' },
      { name: 'commitment', type: 'bytes32' },
      { name: 'expiresAt', type: 'uint64' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'revoke',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'referenceId', type: 'bytes32' },
      { name: 'reason', type: 'string' },
    ],
    outputs: [],
  },
] as const;
