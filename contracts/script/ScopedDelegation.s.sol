// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console} from "forge-std/Script.sol";

import {ZegelIssuerRegistry} from "../src/ZegelIssuerRegistry.sol";
import {IRegistry} from "../src/interfaces/IRegistry.sol";

/// @notice The four-level scoping demonstration, as broadcastable transactions.
///
/// @dev Three steps, each its own transaction so the effect of each is separately visible on a block
///      explorer: register a name, delegate exactly one record on it, then take the delegation back.
///      Read the state between steps with:
///        `cast call $REGISTRY "hasScopedRoles(uint256,bytes32,uint256,address)(bool)" $ID $PART $ROLE $AGENT`
contract ScopedDelegation is Script {
    string internal constant ENVELOPE_KEY = "zegel.envelope.v1";
    uint256 internal constant ROLE_SET_DATA = 1 << 36;

    /// @notice Step 1. Register the issuer name with the full owner bundle.
    function register(ZegelIssuerRegistry registry, string calldata label, uint64 expiry)
        external
        returns (uint256 tokenId)
    {
        address owner = vm.envAddress("ZEGEL_OWNER");
        address resolver = vm.envOr("ZEGEL_RESOLVER", address(0));
        uint256 ownerRoles = registry.OWNER_ROLES();

        vm.startBroadcast();
        tokenId = registry.register(label, owner, IRegistry(address(0)), resolver, ownerRoles, expiry);
        vm.stopBroadcast();

        uint256 canonicalId = registry.canonicalIdOf(label);
        console.log("label      ", label);
        console.log("tokenId    ", tokenId);
        console.log("canonicalId", canonicalId);
        console.log(
            "resource   ", registry.resource(registry.nodeOf(canonicalId), registry.dataPart(ENVELOPE_KEY))
        );
    }

    /// @notice Step 2. Give an issuing agent the right to write the envelope record on this one name.
    ///         Not the resolver, not a second key, not a second name.
    function delegate(ZegelIssuerRegistry registry, string calldata label, address agent) external {
        uint256 canonicalId = registry.canonicalIdOf(label);

        vm.startBroadcast();
        registry.grantRecordRoles(canonicalId, ENVELOPE_KEY, ROLE_SET_DATA, agent);
        vm.stopBroadcast();

        console.log("agent   ", agent);
        console.log(
            "resource", registry.resource(registry.nodeOf(canonicalId), registry.dataPart(ENVELOPE_KEY))
        );
        console.log(
            "granted ",
            registry.hasScopedRoles(canonicalId, registry.dataPart(ENVELOPE_KEY), ROLE_SET_DATA, agent)
        );
    }

    /// @notice Step 3a. Take back that one grant, leaving every other grant on the name intact.
    function revokeOne(ZegelIssuerRegistry registry, string calldata label, address agent) external {
        uint256 canonicalId = registry.canonicalIdOf(label);

        vm.startBroadcast();
        registry.revokeRecordRoles(canonicalId, ENVELOPE_KEY, ROLE_SET_DATA, agent);
        vm.stopBroadcast();

        console.log(
            "granted",
            registry.hasScopedRoles(canonicalId, registry.dataPart(ENVELOPE_KEY), ROLE_SET_DATA, agent)
        );
    }

    /// @notice Step 3b. The wider option: bump the EAC version and invalidate every grant on the name
    ///         at once, regenerating the token id.
    function revokeAll(ZegelIssuerRegistry registry, string calldata label) external {
        uint256 canonicalId = registry.canonicalIdOf(label);
        uint256 tokenIdBefore = registry.tokenIdOf(canonicalId);
        uint256 nodeBefore = registry.nodeOf(canonicalId);

        vm.startBroadcast();
        uint256 tokenIdAfter = registry.bumpEacVersion(canonicalId);
        vm.stopBroadcast();

        console.log("tokenId before", tokenIdBefore);
        console.log("tokenId after ", tokenIdAfter);
        console.log("node before   ", nodeBefore);
        console.log("node after    ", registry.nodeOf(canonicalId));
        console.log("eacVersionId  ", registry.getEntry(canonicalId).eacVersionId);
    }
}
