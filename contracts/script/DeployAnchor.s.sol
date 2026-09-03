// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console} from "forge-std/Script.sol";

import {ZegelAnchor} from "../src/ZegelAnchor.sol";

/// @notice Deploys `ZegelAnchor` to Base mainnet (8453).
///
/// @dev The contract has no constructor arguments and no owner. Anchoring is permissionless and each
///      reference id belongs to whoever claimed it first, so nothing here needs configuring after
///      deployment. Chosen for Base because a revocation should cost the issuer nothing worth
///      hesitating over.
contract DeployAnchor is Script {
    function run() external returns (ZegelAnchor anchorContract) {
        vm.startBroadcast();
        anchorContract = new ZegelAnchor();
        vm.stopBroadcast();

        console.log("ZegelAnchor", address(anchorContract));
        console.log("chainId    ", block.chainid);
    }
}
