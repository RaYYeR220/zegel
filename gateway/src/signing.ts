import { concatHex, keccak256, numberToHex, type Address, type Hex } from 'viem';
import { privateKeyToAccount, sign } from 'viem/accounts';

/**
 * The EIP-191 version `0x00` ("intended validator") digest `ZegelResolver` verifies:
 *
 * ```
 * keccak256(0x1900 ‖ resolver ‖ expires ‖ keccak256(callData) ‖ keccak256(result))
 * ```
 *
 * Every field is load-bearing. `resolver` stops a response being replayed into a
 * different contract that trusts the same signer; `callData` binds it to one name
 * and one record key; `expires` bounds how long the response — which is a bearer
 * token, by construction — stays usable.
 */
export function makeSignatureHash(
  resolver: Address,
  expires: bigint,
  callData: Hex,
  result: Hex,
): Hex {
  return keccak256(
    concatHex([
      '0x1900',
      resolver,
      numberToHex(expires, { size: 8 }),
      keccak256(callData),
      keccak256(result),
    ]),
  );
}

export interface ResponseSigner {
  readonly address: Address;
  /** 65 bytes, `r ‖ s ‖ v` with `v` in {27, 28} and `s` in the low half of the curve order. */
  signResponse(resolver: Address, expires: bigint, callData: Hex, result: Hex): Promise<Hex>;
}

/**
 * `ZegelResolver` rejects a high-`s` signature so that a response has exactly one
 * representation. viem signs through noble, which is canonically low-`s`, so no
 * normalisation is needed here — but the property is asserted in the tests rather
 * than assumed, because a malleable signature would fail only on chain.
 */
export function createSigner(privateKey: Hex): ResponseSigner {
  const account = privateKeyToAccount(privateKey);

  return {
    address: account.address,
    async signResponse(resolver, expires, callData, result) {
      return sign({
        hash: makeSignatureHash(resolver, expires, callData, result),
        privateKey,
        to: 'hex',
      });
    },
  };
}
