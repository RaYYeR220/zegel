// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @notice ENSIP-24 arbitrary data resolution.
/// @dev ERC-165 interface id `0xecbfada3`. The mainnet PublicResolver does not implement this
///      profile, so a name that wants a `data()` record needs a resolver that does.
interface IDataResolver {
    event DataChanged(bytes32 indexed node, string indexed indexedKey, string key, bytes indexed indexedData);

    function data(bytes32 node, string calldata key) external view returns (bytes memory);
}

/// @notice Optional companion to ENSIP-24 that lets a client enumerate a node's data keys.
/// @dev ERC-165 interface id `0x29fb1892`.
interface ISupportedDataKeys {
    function supportedDataKeys(bytes32 node) external view returns (string[] memory);
}
