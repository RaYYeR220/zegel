// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @notice The off-chain half of the CCIP-Read round trip.
/// @dev Never deployed. Its selectors are the wire format the gateway parses out of `callData`, and
///      the whole encoded call is what the gateway's signature commits to.
interface IZegelGatewayService {
    /// @dev Selector `0x9061b923`, matching ENSIP-10 by construction.
    /// @return result The ABI-encoded return data of the inner resolver call.
    /// @return expires Unix seconds after which the signature is refused on chain.
    /// @return signature 65-byte EIP-191 intended-validator signature over the response.
    function resolve(bytes calldata name, bytes calldata data)
        external
        view
        returns (bytes memory result, uint64 expires, bytes memory signature);
}
