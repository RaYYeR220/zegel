// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";

import {ZegelAnchor} from "../src/ZegelAnchor.sol";

contract ZegelAnchorTest is Test {
    ZegelAnchor internal anchorContract;

    address internal issuer = makeAddr("issuer");
    address internal stranger = makeAddr("stranger");

    bytes32 internal constant REFERENCE = keccak256("zegel:reference:alice:2026-09");
    bytes32 internal constant COMMITMENT = keccak256("canonical claim set");
    /// @dev The negative control: what a claim set looks like after one number has been edited.
    bytes32 internal constant TAMPERED = keccak256("canonical claim set with pnl bumped");

    uint64 internal expiry;

    event Anchored(bytes32 indexed referenceId, bytes32 commitment, address indexed issuer, uint64 expiresAt);
    event Revoked(bytes32 indexed referenceId, address indexed issuer, string reason, uint64 at);

    function setUp() public {
        vm.warp(1_800_000_000);
        anchorContract = new ZegelAnchor();
        expiry = uint64(block.timestamp + 30 days);
    }

    // ---------------------------------------------------------------------------------------------
    // Anchoring
    // ---------------------------------------------------------------------------------------------

    function test_Anchor() public {
        vm.expectEmit(true, true, true, true);
        emit Anchored(REFERENCE, COMMITMENT, issuer, expiry);

        vm.prank(issuer);
        anchorContract.anchor(REFERENCE, COMMITMENT, expiry);

        ZegelAnchor.Anchor memory a = anchorContract.getAnchor(REFERENCE);
        assertEq(a.commitment, COMMITMENT);
        assertEq(a.issuer, issuer);
        assertEq(a.expiresAt, expiry);
        assertEq(a.anchoredAt, uint64(block.timestamp));
        assertEq(a.revokedAt, 0);
        assertTrue(anchorContract.isValid(REFERENCE));
        assertEq(anchorContract.issuerOf(REFERENCE), issuer);
    }

    function test_RevertWhen_AnchoringZeroReference() public {
        vm.prank(issuer);
        vm.expectRevert(ZegelAnchor.ZeroReferenceId.selector);
        anchorContract.anchor(bytes32(0), COMMITMENT, expiry);
    }

    function test_RevertWhen_AnchoringZeroCommitment() public {
        vm.prank(issuer);
        vm.expectRevert(ZegelAnchor.ZeroCommitment.selector);
        anchorContract.anchor(REFERENCE, bytes32(0), expiry);
    }

    function test_RevertWhen_ExpiryInPast() public {
        uint64 stale = uint64(block.timestamp);
        vm.prank(issuer);
        vm.expectRevert(
            abi.encodeWithSelector(ZegelAnchor.ExpiryInPast.selector, stale, uint64(block.timestamp))
        );
        anchorContract.anchor(REFERENCE, COMMITMENT, stale);
    }

    /// @dev Re-anchoring is how an issuer refreshes an expiry or corrects a claim set without
    ///      invalidating an envelope that already points at the id.
    function test_IssuerMayReAnchor() public {
        _anchor();

        bytes32 corrected = keccak256("corrected claim set");
        uint64 later = expiry + 30 days;

        vm.prank(issuer);
        anchorContract.anchor(REFERENCE, corrected, later);

        ZegelAnchor.Anchor memory a = anchorContract.getAnchor(REFERENCE);
        assertEq(a.commitment, corrected);
        assertEq(a.expiresAt, later);
        assertEq(a.issuer, issuer, "issuer is not reassigned");
    }

    function test_RevertWhen_StrangerReAnchors() public {
        _anchor();

        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(ZegelAnchor.NotIssuer.selector, stranger, issuer));
        anchorContract.anchor(REFERENCE, keccak256("hijack"), expiry);
    }

    // ---------------------------------------------------------------------------------------------
    // Revocation
    // ---------------------------------------------------------------------------------------------

    function test_RevokeIsObservableWithoutDecrypting() public {
        _anchor();

        vm.expectEmit(true, true, true, true);
        emit Revoked(REFERENCE, issuer, "deal closed", uint64(block.timestamp));

        vm.prank(issuer);
        anchorContract.revoke(REFERENCE, "deal closed");

        assertFalse(anchorContract.isValid(REFERENCE));
        assertEq(uint256(anchorContract.verify(REFERENCE, COMMITMENT)), uint256(ZegelAnchor.Status.Revoked));
        assertEq(anchorContract.getAnchor(REFERENCE).revokedAt, uint64(block.timestamp));
    }

    function test_RevertWhen_StrangerRevokes() public {
        _anchor();

        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(ZegelAnchor.NotIssuer.selector, stranger, issuer));
        anchorContract.revoke(REFERENCE, "not yours");
    }

    function test_RevertWhen_RevokingUnanchored() public {
        vm.prank(issuer);
        vm.expectRevert(abi.encodeWithSelector(ZegelAnchor.NotAnchored.selector, REFERENCE));
        anchorContract.revoke(REFERENCE, "nothing here");
    }

    function test_RevertWhen_RevokingTwice() public {
        _anchor();
        vm.startPrank(issuer);
        anchorContract.revoke(REFERENCE, "first");

        vm.expectRevert(
            abi.encodeWithSelector(ZegelAnchor.AlreadyRevoked.selector, REFERENCE, uint64(block.timestamp))
        );
        anchorContract.revoke(REFERENCE, "second");
        vm.stopPrank();
    }

    /// @notice The one-way door. An issuer must not be able to rehabilitate a withdrawn reference.
    function test_RevertWhen_ReAnchoringAfterRevoke() public {
        _anchor();
        vm.startPrank(issuer);
        anchorContract.revoke(REFERENCE, "withdrawn");

        vm.expectRevert(
            abi.encodeWithSelector(ZegelAnchor.AlreadyRevoked.selector, REFERENCE, uint64(block.timestamp))
        );
        anchorContract.anchor(REFERENCE, COMMITMENT, expiry + 1 days);
        vm.stopPrank();
    }

    function test_RevertWhen_ReasonTooLong() public {
        _anchor();

        string memory reason = new string(257);
        uint256 maximum = anchorContract.MAX_REASON_BYTES();

        vm.prank(issuer);
        vm.expectRevert(abi.encodeWithSelector(ZegelAnchor.ReasonTooLong.selector, 257, maximum));
        anchorContract.revoke(REFERENCE, reason);
    }

    // ---------------------------------------------------------------------------------------------
    // verify() — the rich status a UI branches on
    // ---------------------------------------------------------------------------------------------

    function test_Verify_NeverAnchored() public view {
        assertEq(
            uint256(anchorContract.verify(REFERENCE, COMMITMENT)), uint256(ZegelAnchor.Status.NeverAnchored)
        );
    }

    function test_Verify_Valid() public {
        _anchor();
        assertEq(uint256(anchorContract.verify(REFERENCE, COMMITMENT)), uint256(ZegelAnchor.Status.Valid));
    }

    /// @notice The negative control. A claim set with one number edited hashes to something else, and
    ///         the anchor says so without anyone having to decrypt anything.
    function test_Verify_CommitmentMismatch() public {
        _anchor();
        assertEq(
            uint256(anchorContract.verify(REFERENCE, TAMPERED)),
            uint256(ZegelAnchor.Status.CommitmentMismatch)
        );
        // The reference itself is still live — only the caller's copy is wrong.
        assertTrue(anchorContract.isValid(REFERENCE));
    }

    function test_Verify_Expired() public {
        _anchor();
        vm.warp(expiry);
        assertEq(uint256(anchorContract.verify(REFERENCE, COMMITMENT)), uint256(ZegelAnchor.Status.Expired));
        assertFalse(anchorContract.isValid(REFERENCE));
    }

    /// @dev Lifecycle beats content: a revoked reference reads as revoked even when the caller also
    ///      brought the wrong commitment, because the reader's next action is the same either way.
    function test_Verify_RevocationOutranksMismatch() public {
        _anchor();
        vm.prank(issuer);
        anchorContract.revoke(REFERENCE, "withdrawn");

        assertEq(uint256(anchorContract.verify(REFERENCE, TAMPERED)), uint256(ZegelAnchor.Status.Revoked));
    }

    function test_IsValidIsFalseUntilAnchored() public view {
        assertFalse(anchorContract.isValid(REFERENCE));
    }

    /// @dev Anyone may claim an unclaimed id. That is harmless: the claim set they did not write will
    ///      not hash to the commitment they anchored, so a verifier sees a mismatch.
    function test_SquattingAnIdProducesAMismatch() public {
        vm.prank(stranger);
        anchorContract.anchor(REFERENCE, keccak256("squatted"), expiry);

        assertEq(
            uint256(anchorContract.verify(REFERENCE, COMMITMENT)),
            uint256(ZegelAnchor.Status.CommitmentMismatch)
        );
    }

    // ---------------------------------------------------------------------------------------------
    // Fuzz
    // ---------------------------------------------------------------------------------------------

    function testFuzz_AnchorLifecycle(
        bytes32 referenceId,
        bytes32 commitment,
        uint64 lifetime,
        address who,
        uint32 elapsed
    ) public {
        vm.assume(referenceId != bytes32(0));
        vm.assume(commitment != bytes32(0));
        vm.assume(who != address(0));
        lifetime = uint64(bound(lifetime, 1, 3650 days));

        uint64 anchoredAt = uint64(block.timestamp);
        uint64 expiresAt = anchoredAt + lifetime;

        vm.prank(who);
        anchorContract.anchor(referenceId, commitment, expiresAt);
        assertTrue(anchorContract.isValid(referenceId));
        assertEq(uint256(anchorContract.verify(referenceId, commitment)), uint256(ZegelAnchor.Status.Valid));

        vm.warp(anchoredAt + elapsed);
        bool live = expiresAt > block.timestamp;
        assertEq(anchorContract.isValid(referenceId), live);
        assertEq(
            uint256(anchorContract.verify(referenceId, commitment)),
            live ? uint256(ZegelAnchor.Status.Valid) : uint256(ZegelAnchor.Status.Expired)
        );
    }

    function testFuzz_AnyOtherCommitmentMismatches(bytes32 commitment, bytes32 presented) public {
        vm.assume(commitment != bytes32(0));
        vm.assume(commitment != presented);

        vm.prank(issuer);
        anchorContract.anchor(REFERENCE, commitment, expiry);

        assertEq(
            uint256(anchorContract.verify(REFERENCE, presented)),
            uint256(ZegelAnchor.Status.CommitmentMismatch)
        );
    }

    function testFuzz_OnlyIssuerMayRevoke(address caller) public {
        _anchor();
        vm.assume(caller != issuer);

        vm.prank(caller);
        vm.expectRevert(abi.encodeWithSelector(ZegelAnchor.NotIssuer.selector, caller, issuer));
        anchorContract.revoke(REFERENCE, "attempt");
    }

    /// @dev Once revoked, no reachable call and no passage of time makes the reference valid again.
    function testFuzz_RevokedIsTerminal(uint64 lifetime, uint32 elapsed, bytes32 commitment) public {
        vm.assume(commitment != bytes32(0));
        lifetime = uint64(bound(lifetime, 1, 3650 days));

        vm.startPrank(issuer);
        anchorContract.anchor(REFERENCE, commitment, uint64(block.timestamp) + lifetime);
        anchorContract.revoke(REFERENCE, "withdrawn");

        vm.warp(block.timestamp + elapsed);
        vm.expectPartialRevert(ZegelAnchor.AlreadyRevoked.selector);
        anchorContract.anchor(REFERENCE, commitment, uint64(block.timestamp) + 365 days);
        vm.stopPrank();

        assertFalse(anchorContract.isValid(REFERENCE));
        assertEq(uint256(anchorContract.verify(REFERENCE, commitment)), uint256(ZegelAnchor.Status.Revoked));
    }

    function _anchor() private {
        vm.prank(issuer);
        anchorContract.anchor(REFERENCE, COMMITMENT, expiry);
    }
}
