// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @notice Two-step ownership. Handing control to an address that cannot accept it is the one
///         ownership mistake that is unrecoverable, so the transfer is not complete until the
///         recipient proves it can transact.
abstract contract Owned {
    error Unauthorized(address caller);
    error NotPendingOwner(address caller);

    event OwnershipTransferStarted(address indexed previousOwner, address indexed newOwner);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    address public owner;
    address public pendingOwner;

    modifier onlyOwner() {
        if (msg.sender != owner) revert Unauthorized(msg.sender);
        _;
    }

    constructor(address initialOwner) {
        if (initialOwner == address(0)) revert Unauthorized(address(0));
        owner = initialOwner;
        emit OwnershipTransferred(address(0), initialOwner);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        pendingOwner = newOwner;
        emit OwnershipTransferStarted(owner, newOwner);
    }

    function acceptOwnership() external {
        if (msg.sender != pendingOwner) revert NotPendingOwner(msg.sender);
        address previous = owner;
        owner = msg.sender;
        delete pendingOwner;
        emit OwnershipTransferred(previous, msg.sender);
    }
}
