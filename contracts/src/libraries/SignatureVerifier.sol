// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @notice EIP-191 version `0x00` ("intended validator") verification for CCIP-Read responses.
/// @dev The digest layout is the one every ENS offchain resolver has used since the reference
///      implementation, so a gateway written against any of them signs correctly against this one.
library SignatureVerifier {
    error MalformedSignature();
    error MalleableSignature();

    /// @dev secp256k1 group order / 2. Signatures above it are the mirror of a valid one and are
    ///      refused so a response has exactly one representation.
    uint256 private constant HALF_ORDER = 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0;

    /// @param target The resolver the response is bound to. Binding this is what stops a response
    ///        minted for one resolver being replayed into another that trusts the same signer.
    /// @param expires Unix seconds after which the response is stale.
    /// @param request The exact `callData` handed to the gateway. Binding this is what stops a
    ///        response for one name being replayed against another.
    /// @param result The gateway's answer.
    function makeSignatureHash(address target, uint64 expires, bytes memory request, bytes memory result)
        internal
        pure
        returns (bytes32)
    {
        return keccak256(abi.encodePacked(hex"1900", target, expires, keccak256(request), keccak256(result)));
    }

    function recoverSigner(bytes32 digest, bytes memory signature) internal pure returns (address) {
        if (signature.length != 65) revert MalformedSignature();

        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly ("memory-safe") {
            r := mload(add(signature, 0x20))
            s := mload(add(signature, 0x40))
            v := byte(0, mload(add(signature, 0x60)))
        }

        if (uint256(s) > HALF_ORDER) revert MalleableSignature();
        if (v != 27 && v != 28) revert MalformedSignature();

        address signer = ecrecover(digest, v, r, s);
        if (signer == address(0)) revert MalformedSignature();
        return signer;
    }
}
