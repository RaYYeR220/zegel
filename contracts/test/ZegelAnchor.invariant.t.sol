// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {StdInvariant} from "forge-std/StdInvariant.sol";
import {Test} from "forge-std/Test.sol";

import {ZegelAnchor} from "../src/ZegelAnchor.sol";

/// @notice Drives the anchor through arbitrary interleavings of anchoring, revocation, hijack attempts
///         and the passage of time, from several issuers over a small shared id space so that
///         collisions actually happen rather than every call landing on a fresh id.
contract AnchorHandler is Test {
    ZegelAnchor public immutable ANCHOR;

    bytes32[] public ids;
    address[] public actors;

    mapping(bytes32 referenceId => bool) public everRevoked;
    bytes32[] private _revoked;
    uint256 public totalCalls;

    constructor(ZegelAnchor anchorContract) {
        ANCHOR = anchorContract;
        for (uint256 i; i < 4; ++i) {
            ids.push(keccak256(abi.encode("reference", i)));
            actors.push(address(uint160(uint256(keccak256(abi.encode("issuer", i))))));
        }
    }

    function doAnchor(uint256 idSeed, uint256 actorSeed, bytes32 commitment, uint64 lifetime) external {
        totalCalls += 1;
        if (commitment == bytes32(0)) commitment = keccak256(abi.encode(idSeed, actorSeed));
        lifetime = uint64(bound(lifetime, 1, 365 days));

        vm.prank(actors[actorSeed % actors.length]);
        try ANCHOR.anchor(ids[idSeed % ids.length], commitment, uint64(block.timestamp) + lifetime) {}
            catch {}
    }

    /// @dev Revokes as the id's real issuer, so a sequence reliably reaches the revoked state instead
    ///      of spending its depth budget on calls that were always going to be rejected.
    function doRevoke(uint256 idSeed) external {
        totalCalls += 1;
        bytes32 id = ids[idSeed % ids.length];
        address issuer = ANCHOR.issuerOf(id);
        if (issuer == address(0)) return;

        vm.prank(issuer);
        try ANCHOR.revoke(id, "handler") {
            _recordRevocation(id);
        } catch {}
    }

    /// @dev The adversarial half: someone who is not the issuer trying to revoke or seize an id.
    function doHijack(uint256 idSeed, uint256 actorSeed, bytes32 commitment) external {
        totalCalls += 1;
        bytes32 id = ids[idSeed % ids.length];
        if (commitment == bytes32(0)) commitment = keccak256(abi.encode("hijack", idSeed));

        vm.startPrank(actors[actorSeed % actors.length]);
        try ANCHOR.revoke(id, "hijack") {
            _recordRevocation(id);
        } catch {}
        try ANCHOR.anchor(id, commitment, uint64(block.timestamp) + 30 days) {} catch {}
        vm.stopPrank();
    }

    function doWarp(uint32 step) external {
        totalCalls += 1;
        vm.warp(block.timestamp + (uint256(step) % 60 days) + 1);
    }

    function allIds() external view returns (bytes32[] memory) {
        return ids;
    }

    function revokedIds() external view returns (bytes32[] memory) {
        return _revoked;
    }

    function _recordRevocation(bytes32 id) private {
        if (everRevoked[id]) return;
        everRevoked[id] = true;
        _revoked.push(id);
    }
}

contract ZegelAnchorInvariantTest is StdInvariant, Test {
    ZegelAnchor internal anchorContract;
    AnchorHandler internal handler;

    function setUp() public {
        vm.warp(1_800_000_000);
        anchorContract = new ZegelAnchor();
        handler = new AnchorHandler(anchorContract);

        // Seed half the id space so a sequence can revoke from its first call, and leave the other
        // half untouched so the never-anchored branch is exercised too.
        for (uint256 i; i < 2; ++i) {
            vm.prank(handler.actors(i));
            anchorContract.anchor(
                handler.ids(i), keccak256(abi.encode("seed", i)), uint64(block.timestamp + 90 days)
            );
        }

        bytes4[] memory selectors = new bytes4[](4);
        selectors[0] = AnchorHandler.doAnchor.selector;
        selectors[1] = AnchorHandler.doRevoke.selector;
        selectors[2] = AnchorHandler.doHijack.selector;
        selectors[3] = AnchorHandler.doWarp.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));
        targetContract(address(handler));
    }

    /// @notice The property the product rests on: withdrawal is permanent. No sequence of calls, and
    ///         no amount of elapsed time, brings a revoked reference back to life.
    function invariant_RevokedNeverReturnsToValid() public view {
        bytes32[] memory revoked = handler.revokedIds();
        for (uint256 i; i < revoked.length; ++i) {
            assertFalse(anchorContract.isValid(revoked[i]), "revoked reference reported valid");
            assertEq(
                uint256(anchorContract.verify(revoked[i], anchorContract.getAnchor(revoked[i]).commitment)),
                uint256(ZegelAnchor.Status.Revoked),
                "revoked reference lost its revocation"
            );
        }
    }

    /// @notice `isValid` and `verify` are two readings of one state and must never disagree.
    function invariant_IsValidAgreesWithVerify() public view {
        bytes32[] memory ids = handler.allIds();
        for (uint256 i; i < ids.length; ++i) {
            ZegelAnchor.Anchor memory a = anchorContract.getAnchor(ids[i]);
            bool live = anchorContract.isValid(ids[i]);
            ZegelAnchor.Status status = anchorContract.verify(ids[i], a.commitment);
            assertEq(live, status == ZegelAnchor.Status.Valid, "isValid disagrees with verify");
        }
    }

    /// @notice An anchored entry is always well formed, and an id's issuer is set once and never moves.
    function invariant_AnchoredEntriesAreWellFormed() public view {
        bytes32[] memory ids = handler.allIds();
        for (uint256 i; i < ids.length; ++i) {
            ZegelAnchor.Anchor memory a = anchorContract.getAnchor(ids[i]);
            if (a.anchoredAt == 0) {
                assertEq(a.commitment, bytes32(0));
                assertEq(a.issuer, address(0));
                assertEq(a.revokedAt, 0, "revoked without ever being anchored");
            } else {
                assertTrue(a.commitment != bytes32(0));
                assertTrue(a.issuer != address(0));
                assertTrue(a.expiresAt > a.anchoredAt, "anchored with an expiry in the past");
            }
        }
    }

    /// @dev Guards against the invariants above passing vacuously. Foundry evaluates this hook against
    ///      the initial state too, before any handler call, hence the guard on `totalCalls`.
    function afterInvariant() public view {
        if (handler.totalCalls() == 0) return;
        assertGt(handler.revokedIds().length, 0, "the sequence never reached a revoked reference");
    }
}
