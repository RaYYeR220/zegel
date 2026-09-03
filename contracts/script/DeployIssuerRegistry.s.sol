// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console} from "forge-std/Script.sol";

import {ZegelIssuerRegistry} from "../src/ZegelIssuerRegistry.sol";
import {IRegistry} from "../src/interfaces/IRegistry.sol";

/// @notice Deploys `ZegelIssuerRegistry` to Sepolia and points it at the live ENSv2 stack.
///
/// @dev The ENSv2 addresses below were re-checked with `cast code` against Sepolia on 2026-09-03 and
///      all returned bytecode; `RootRegistry.getSubregistry("eth")` returned the `ETHRegistry` address
///      quoted here, and both registries answered `supportsInterface(0x51f67f40)` and
///      `supportsInterface(0x8f452d62)` with true.
///
///      **Check them again before you broadcast.** The Sepolia stack has been redeployed four times in
///      three months and every address in it moves on a full redeploy:
///        `cast code 0xbdc85dd5b15d7ecb354cd7cb6f2c50b4f2c4f0e2 --rpc-url $SEPOLIA_RPC_URL`
///
///      Attaching the registry to a name is a second step taken by that name's owner against the
///      parent registry: `setSubregistry(tokenId, address(this))` on the parent, then `setParent`
///      here so the link is legible from both ends. `setParent` is write-once, so run it only once
///      the parent registration is final.
contract DeployIssuerRegistry is Script {
    /// @dev ENSv2 Sepolia, deployment tagged `sepolia-deployment-2026-07-31`.
    address internal constant ENSV2_ROOT_REGISTRY = 0x8115186E8f2E0B0281e86ab91f0f48Ba90364354;
    address internal constant ENSV2_ETH_REGISTRY = 0xBDC85dD5b15D7ecb354cd7cb6f2c50b4f2c4F0E2;
    address internal constant ENSV2_UNIVERSAL_RESOLVER = 0xeEeEEEeE14D718C2B47D9923Deab1335E144EeEe;
    address internal constant ENSV2_PERMISSIONED_RESOLVER_IMPL = 0x9EAe5C2730a7dD16BDD1DeE6421a1B91e3B0365e;
    address internal constant ENSV2_VERIFIABLE_FACTORY = 0x10dC6333CDFe1FCEf624c6e0a8221b91804Cd7ef;

    function run() external returns (ZegelIssuerRegistry registry) {
        address root = vm.envAddress("ZEGEL_OWNER");

        require(ENSV2_ETH_REGISTRY.code.length != 0, "ETHRegistry has no code: the stack was redeployed");
        require(ENSV2_ROOT_REGISTRY.code.length != 0, "RootRegistry has no code: the stack was redeployed");

        vm.startBroadcast();
        registry = new ZegelIssuerRegistry(root);
        vm.stopBroadcast();

        console.log("ZegelIssuerRegistry", address(registry));
        console.log("root               ", root);
        console.log("ENSv2 RootRegistry ", ENSV2_ROOT_REGISTRY);
        console.log("ENSv2 ETHRegistry  ", ENSV2_ETH_REGISTRY);
        console.log("ENSv2 UR           ", ENSV2_UNIVERSAL_RESOLVER);
    }

    /// @notice Second step, once the parent registration exists. Write-once by design.
    function link(ZegelIssuerRegistry registry, address parent, string calldata label) external {
        vm.startBroadcast();
        registry.setParent(IRegistry(parent), label);
        vm.stopBroadcast();
    }
}
