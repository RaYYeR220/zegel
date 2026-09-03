// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title ZegelAnchor
/// @notice The public, cheap, always-readable half of a Zegel reference: a commitment to a sealed
///         claim set, its expiry, and whether its issuer has withdrawn it. Deployed to Base.
///
/// @dev The point of this contract is that **revocation is observable without decrypting anything**.
/// The sealed evidence lives on Swarm under ACT and a reader who was never granted access cannot
/// distinguish "revoked" from "never existed" - which is the right answer for a reader, and the wrong
/// answer for a counterparty who legitimately holds a copy and needs to know it has gone stale. So
/// the lifecycle is mirrored here in the clear, keyed by a reference id that reveals nothing on its
/// own, and anyone can read it with an `eth_call` and no credentials.
///
/// Revocation is deliberately one-way. Swarm ACT revocation is soft - a grantee keeps whatever they
/// already downloaded, and the honest framing is "cut off from here on", never "unsend". A reference
/// that could be un-revoked would let an issuer quietly rehabilitate a withdrawn claim set, so
/// `anchor` refuses to touch a revoked id and a new reference needs a new id.
///
/// There is no owner and no admin. Anyone may anchor an id nobody has claimed; only the address that
/// first claimed it may re-anchor or revoke it. Squatting an id you did not issue is possible and
/// harmless: the id is `sha256`-derived from the reference, and a squatted anchor commits to a
/// commitment the real evidence will not match, which `verify` reports as a mismatch.
contract ZegelAnchor {
    error ZeroReferenceId();
    error ZeroCommitment();
    error ExpiryInPast(uint64 expiresAt, uint64 currentTime);
    error NotIssuer(address caller, address issuer);
    error NotAnchored(bytes32 referenceId);
    error AlreadyRevoked(bytes32 referenceId, uint64 revokedAt);
    error ReasonTooLong(uint256 length, uint256 maximum);

    event Anchored(bytes32 indexed referenceId, bytes32 commitment, address indexed issuer, uint64 expiresAt);
    event Revoked(bytes32 indexed referenceId, address indexed issuer, string reason, uint64 at);

    /// @notice Why a reference cannot be trusted, or that it can.
    /// @dev Ordered so a UI can branch without a second call. Lifecycle beats content: a revoked
    ///      reference reports `Revoked` even if the caller also brought the wrong commitment,
    ///      because the reader's next action ("stop relying on this") is the same either way.
    ///      `CommitmentMismatch` is the negative control - it is what a tampered claim set produces
    ///      against a live, unrevoked anchor.
    enum Status {
        NeverAnchored,
        Valid,
        Expired,
        Revoked,
        CommitmentMismatch
    }

    struct Anchor {
        /// @dev sha256 over the canonical claim set. Zero iff the id was never anchored.
        bytes32 commitment;
        address issuer;
        uint64 expiresAt;
        uint64 anchoredAt;
        /// @dev Nonzero once revoked, and never cleared.
        uint64 revokedAt;
    }

    /// @dev A revocation reason is a human string shown to a counterparty, not a data channel.
    uint256 public constant MAX_REASON_BYTES = 256;

    mapping(bytes32 referenceId => Anchor) private _anchors;

    /// @notice Commit to a claim set under `referenceId`.
    /// @dev Re-anchoring is how an issuer refreshes an expiry or publishes a corrected claim set. It
    ///      keeps the id, so any envelope already pointing at it stays valid, and it emits a fresh
    ///      `Anchored` so the change is auditable rather than silent.
    function anchor(bytes32 referenceId, bytes32 commitment, uint64 expiresAt) external {
        if (referenceId == bytes32(0)) revert ZeroReferenceId();
        if (commitment == bytes32(0)) revert ZeroCommitment();
        if (expiresAt <= block.timestamp) revert ExpiryInPast(expiresAt, uint64(block.timestamp));

        Anchor storage a = _anchors[referenceId];
        if (a.anchoredAt == 0) {
            a.issuer = msg.sender;
        } else {
            if (a.issuer != msg.sender) revert NotIssuer(msg.sender, a.issuer);
            if (a.revokedAt != 0) revert AlreadyRevoked(referenceId, a.revokedAt);
        }

        a.commitment = commitment;
        a.expiresAt = expiresAt;
        a.anchoredAt = uint64(block.timestamp);

        emit Anchored(referenceId, commitment, msg.sender, expiresAt);
    }

    /// @notice Withdraw a reference. Permanent.
    function revoke(bytes32 referenceId, string calldata reason) external {
        Anchor storage a = _anchors[referenceId];
        if (a.anchoredAt == 0) revert NotAnchored(referenceId);
        if (a.issuer != msg.sender) revert NotIssuer(msg.sender, a.issuer);
        if (a.revokedAt != 0) revert AlreadyRevoked(referenceId, a.revokedAt);
        if (bytes(reason).length > MAX_REASON_BYTES) {
            revert ReasonTooLong(bytes(reason).length, MAX_REASON_BYTES);
        }

        a.revokedAt = uint64(block.timestamp);
        emit Revoked(referenceId, msg.sender, reason, uint64(block.timestamp));
    }

    /// @notice Whether the reference is currently live.
    /// @dev The cheap check, for a caller that has no commitment to compare and only wants to know
    ///      whether to keep going.
    function isValid(bytes32 referenceId) external view returns (bool) {
        Anchor storage a = _anchors[referenceId];
        return a.anchoredAt != 0 && a.revokedAt == 0 && a.expiresAt > block.timestamp;
    }

    /// @notice The full status of a reference against a claim set the caller is holding.
    /// @param commitment sha256 over the canonical claim set the caller decrypted.
    /// @return The reason the caller should or should not rely on it.
    function verify(bytes32 referenceId, bytes32 commitment) external view returns (Status) {
        Anchor storage a = _anchors[referenceId];
        if (a.anchoredAt == 0) return Status.NeverAnchored;
        if (a.revokedAt != 0) return Status.Revoked;
        if (a.expiresAt <= block.timestamp) return Status.Expired;
        if (a.commitment != commitment) return Status.CommitmentMismatch;
        return Status.Valid;
    }

    function getAnchor(bytes32 referenceId) external view returns (Anchor memory) {
        return _anchors[referenceId];
    }

    /// @notice Convenience for indexers: the issuer that owns an id, or zero.
    function issuerOf(bytes32 referenceId) external view returns (address) {
        return _anchors[referenceId].issuer;
    }
}
