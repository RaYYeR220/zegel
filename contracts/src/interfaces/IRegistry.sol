// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @notice The minimum surface a contract must expose to act as an ENSv2 subregistry.
/// @dev ERC-165 interface id `0x51f67f40`
///      (`getSubregistry(string)` ^ `getResolver(string)` ^ `getParent()`).
interface IRegistry {
    /// @return The registry that owns the subtree beneath `label`, or the zero address.
    function getSubregistry(string calldata label) external view returns (IRegistry);

    /// @return The resolver for `label`, or the zero address.
    function getResolver(string calldata label) external view returns (address);

    /// @return parent The registry this one hangs off.
    /// @return label The label this registry is registered under in `parent`.
    function getParent() external view returns (IRegistry parent, string memory label);
}
