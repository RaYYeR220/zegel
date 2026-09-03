import { decodeAbiParameters, encodeAbiParameters, isHex, size, slice, type Hex } from 'viem';
import { namehash } from 'viem/ens';

import { decodeDnsName } from './dns.ts';
import { badRequest } from './errors.ts';

/** ENSIP-24 `data(bytes32,string)`. Pinned in `ZegelResolver.t.sol`. */
export const DATA_SELECTOR = '0xecbfada3' as const;

/** ENSIP-10 `resolve(bytes,bytes)`, which is also the gateway wire selector. */
export const RESOLVE_SELECTOR = '0x9061b923' as const;

export type GatewayQuery =
  | { readonly kind: 'data'; readonly node: Hex; readonly key: string }
  | { readonly kind: 'resolve'; readonly name: string; readonly node: Hex; readonly key: string };

/**
 * Splits the `callData` the resolver put in its `OffchainLookup`.
 *
 * `ZegelResolver` reverts into the same callback from both of its entry points and
 * distinguishes them nowhere but here, by the leading selector:
 *
 * - `0xecbfada3` — a direct `data(node, key)` call.
 * - `0x9061b923` — an ENSIP-10 `resolve(name, request)` wrapping that same call.
 *
 * The two demand different response encodings. See `encodeResult`.
 */
export function decodeQuery(callData: Hex): GatewayQuery {
  if (!isHex(callData)) throw badRequest('callData is not 0x-prefixed hex');
  if (size(callData) < 4) throw badRequest('callData is shorter than a 4-byte selector');

  const selector = slice(callData, 0, 4);
  // `slice` refuses an offset at the end of the value, so a bare selector — which is
  // exactly what a probe or a truncated request looks like — has to be handled here.
  const args = tail(callData);

  if (selector === DATA_SELECTOR) {
    return { kind: 'data', ...decodeDataCall(args) };
  }

  if (selector === RESOLVE_SELECTOR) {
    let name: Hex;
    let request: Hex;
    try {
      [name, request] = decodeAbiParameters([{ type: 'bytes' }, { type: 'bytes' }], args);
    } catch (cause) {
      throw badRequest('resolve(bytes,bytes) arguments do not decode', { cause });
    }

    if (size(request) < 4) throw badRequest('the inner resolver call is shorter than a selector');
    const innerSelector = slice(request, 0, 4);
    if (innerSelector !== DATA_SELECTOR) {
      throw badRequest(
        `this gateway serves only ENSIP-24 data(bytes32,string) (${DATA_SELECTOR}); the inner call is ${innerSelector}`,
      );
    }

    const inner = decodeDataCall(tail(request));
    const decodedName = decodeDnsName(name);

    // Query binding stops a response being replayed onto another name, but only if the
    // node and the name agree in the first place. They are two independent fields of
    // the same request and nothing upstream forces them to match.
    const expected = namehash(decodedName);
    if (expected.toLowerCase() !== inner.node.toLowerCase()) {
      throw badRequest(
        `node ${inner.node} is not the namehash of "${decodedName}" (${expected})`,
      );
    }

    return { kind: 'resolve', name: decodedName, node: inner.node, key: inner.key };
  }

  throw badRequest(`unsupported callData selector ${selector}`);
}

/**
 * Wraps the envelope the way the callback's caller expects to read it.
 *
 * CCIP-Read substitutes the callback's return data for the return data of the
 * *original* call. `data()` returns `bytes`, so a direct query wants the envelope
 * itself. `resolve()` also returns `bytes`, but its value is the ABI-encoded return
 * of the inner call — one more layer of wrapping. Getting this backwards produces a
 * response that verifies on chain and then decodes to garbage in the client, which
 * is the failure mode this whole function exists to prevent.
 */
export function encodeResult(query: GatewayQuery, envelope: Hex): Hex {
  return query.kind === 'data' ? envelope : encodeAbiParameters([{ type: 'bytes' }], [envelope]);
}

/** `abi.encode(bytes result, uint64 expires, bytes signature)` — the resolver's response shape. */
export function encodeResponse(result: Hex, expires: bigint, signature: Hex): Hex {
  return encodeAbiParameters(
    [{ type: 'bytes' }, { type: 'uint64' }, { type: 'bytes' }],
    [result, expires, signature],
  );
}

/** Everything after the 4-byte selector, or `0x` when there is nothing after it. */
function tail(callData: Hex): Hex {
  return size(callData) === 4 ? '0x' : slice(callData, 4);
}

function decodeDataCall(args: Hex): { node: Hex; key: string } {
  try {
    const [node, key] = decodeAbiParameters([{ type: 'bytes32' }, { type: 'string' }], args);
    return { node, key };
  } catch (cause) {
    throw badRequest('data(bytes32,string) arguments do not decode', { cause });
  }
}
