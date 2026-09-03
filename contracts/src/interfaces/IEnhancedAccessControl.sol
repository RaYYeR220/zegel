// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @notice ENSv2 Enhanced Access Control.
/// @dev ERC-165 interface id `0x8f452d62`.
///
///      The role bitmap is nybble-packed: 32 roles occupy the low 128 bits at 4 bits each, and each
///      role's paired admin role sits 128 bits higher. A role constant is therefore the low bit of
///      its nybble (`1 << 0`, `1 << 4`, `1 << 8`, ...) and the spare 3 bits per nybble are used as a
///      per-resource assignee counter, which caps a role at 15 holders per resource.
///
///      Resource `0` is the root resource and is OR'd into every check.
interface IEnhancedAccessControl {
    event EACRolesChanged(
        uint256 indexed resource, address indexed account, uint256 oldRoleBitmap, uint256 newRoleBitmap
    );

    function grantRoles(uint256 resource, uint256 roleBitmap, address account) external returns (bool);
    function grantRootRoles(uint256 roleBitmap, address account) external returns (bool);
    function revokeRoles(uint256 resource, uint256 roleBitmap, address account) external returns (bool);
    function revokeRootRoles(uint256 roleBitmap, address account) external returns (bool);

    function ROOT_RESOURCE() external view returns (uint256);
    function roles(uint256 resource, address account) external view returns (uint256);
    function roleCount(uint256 resource) external view returns (uint256);
    function hasRootRoles(uint256 roleBitmap, address account) external view returns (bool);
    function hasRoles(uint256 resource, uint256 roleBitmap, address account) external view returns (bool);
}
