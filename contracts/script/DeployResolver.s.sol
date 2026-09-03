// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console} from "forge-std/Script.sol";

import {ZegelResolver} from "../src/ZegelResolver.sol";

/// @notice Deploys `ZegelResolver` to Ethereum mainnet.
///
/// @dev Set the name's resolver afterwards with the ENS registry, which is a separate transaction
///      from the owner of the name:
///        `cast send 0x00000000000C2E074eC69A0dFb2997BA6C7d2e1e "setResolver(bytes32,address)" <node> <resolver>`
///
///      `ZEGEL_GATEWAY_URLS` is a comma-separated list. Every entry containing `{data}` is fetched
///      with GET and every entry without it with POST, and clients try them in order, so put the
///      primary first. The URLs are public on chain: never embed an API key in one.
contract DeployResolver is Script {
    function run() external returns (ZegelResolver resolver) {
        address owner = vm.envAddress("ZEGEL_OWNER");
        address signer = vm.envAddress("ZEGEL_GATEWAY_SIGNER");
        string[] memory urls = vm.envString("ZEGEL_GATEWAY_URLS", ",");
        require(urls.length != 0, "ZEGEL_GATEWAY_URLS is empty");

        address[] memory signers = new address[](1);
        signers[0] = signer;

        vm.startBroadcast();
        resolver = new ZegelResolver(owner, urls, signers);
        vm.stopBroadcast();

        console.log("ZegelResolver", address(resolver));
        console.log("owner        ", owner);
        console.log("signer       ", signer);
        for (uint256 i; i < urls.length; ++i) {
            console.log("gateway      ", urls[i]);
        }
    }
}
