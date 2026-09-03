// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @notice ERC-7996 / ENSIP-22 contract feature discovery.
/// @dev ERC-165 interface id `0x582de3e7`. ERC-165 answers "which functions exist"; this answers
///      "which behaviours are honoured", which is what a resolver client actually needs to branch on.
interface IERC7996 {
    function supportsFeature(bytes4 feature) external view returns (bool);
}
