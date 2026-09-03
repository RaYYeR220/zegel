// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @notice ENSIP-10 wildcard resolution.
/// @dev ERC-165 interface id `0x9061b923`.
interface IExtendedResolver {
    /// @param name The full DNS-wire-encoded name, as originally queried. A client that walked up the
    ///        tree to find this resolver still passes the complete name, never the truncated one.
    /// @param data The ABI-encoded call the client wanted to make against a legacy resolver.
    /// @return The ABI-encoded return value of that call.
    function resolve(bytes calldata name, bytes calldata data) external view returns (bytes memory);
}
