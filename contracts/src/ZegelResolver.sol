// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Owned} from "./auth/Owned.sol";
import {IDataResolver, ISupportedDataKeys} from "./interfaces/IDataResolver.sol";
import {IERC7996} from "./interfaces/IERC7996.sol";
import {IExtendedResolver} from "./interfaces/IExtendedResolver.sol";
import {IZegelGatewayService} from "./interfaces/IZegelGatewayService.sol";
import {SignatureVerifier} from "./libraries/SignatureVerifier.sol";

/// @title ZegelResolver
/// @notice An ENS resolver, for Ethereum mainnet, that serves exactly one thing: the public sealed
///         envelope for a private financial reference, under ENSIP-24 `data()`.
///
/// @dev ## Why the gateway is never trusted with anything secret
///
/// A CCIP-Read gateway cannot authenticate its caller, and no amount of care in this contract can
/// change that. `sender` in ERC-3668's `OffchainLookup` is *this contract*, not the reader - it is a
/// routing field. `eth_call` carries no signature, so `msg.sender` is whatever the caller put in the
/// JSON-RPC `from` field, and through the UniversalResolver it is the UniversalResolver anyway.
/// ERC-3668's own security section tells application authors not to send `from` at all, and the
/// mainstream clients comply.
///
/// The consequence is structural rather than incidental. Because `resolveWithProof` authenticates a
/// *signer*, not a *reader*, every response the gateway emits is a freely replayable bearer token for
/// that record until `expires`. One authorised reader fetches once and can publish the signed blob;
/// anyone holding it can feed it back through this callback and get the same answer. Signed therefore
/// means public. There is no configuration of this contract in which that stops being true.
///
/// So the gateway is handed nothing that needs protecting. The envelope it serves is a commitment
/// hash, an expiry, Swarm references and an anchor pointer - metadata *about* ciphertext. The claims
/// themselves are sealed under Swarm ACT, which encrypts to a named recipient's secp256k1 key and
/// needs no HTTP authentication to be sound. An un-granted read of the sealed object returns 404,
/// indistinguishable from a reference that never existed.
///
/// The division of labour is therefore: **Swarm ACT is the access control; this resolver and its
/// gateway are discovery.** The gateway can censor - refuse to answer, and the name stops resolving.
/// It cannot read the reference and it cannot forge one.
///
/// ## What this contract does enforce
///
/// - Authenticity: the response must carry a signature from an owner-allowlisted signer.
/// - Query binding: the signature covers `callData`, so a response minted for one name or one record
///   key cannot be replayed against another.
/// - Resolver binding: the signature covers `address(this)`, so a response cannot be moved between
///   two resolvers that happen to trust the same signer.
/// - Freshness: `expires` is enforced against `block.timestamp`.
/// - Callback binding: `extraData` carries the resolver address and the callback rejects anything
///   that does not name this contract. Through the UniversalResolver the client observes the UR as
///   `sender`, so a callback trusting its caller instead of this field is trivially bypassed.
///
/// ## Response encoding
///
/// The envelope is the canonical-JSON serialisation of `zegel.envelope.v1` as UTF-8 bytes. It is
/// opaque here on purpose: this contract never parses it, so the schema can evolve without a redeploy.
///
/// One asymmetry the gateway must respect, because it is the classic way an offchain resolver breaks
/// silently. CCIP-Read substitutes the callback's return data for the *original* call's return data.
/// `data(bytes32,string)` returns `bytes`, so a response to a direct `data()` query carries the
/// envelope itself. `resolve(bytes,bytes)` also returns `bytes`, but its value is the ABI-encoded
/// return of the inner call - so a response to a `resolve()` query carries `abi.encode(envelope)`.
/// The gateway tells the two apart by the leading selector of `callData`.
contract ZegelResolver is Owned, IExtendedResolver, IDataResolver, ISupportedDataKeys, IERC7996 {
    using SignatureVerifier for bytes32;

    /// @dev ERC-3668. Redeclared here because it is thrown, not caught, and the selector `0x556f1830`
    ///      has to match byte for byte or no client will follow the lookup.
    error OffchainLookup(
        address sender, string[] urls, bytes callData, bytes4 callbackFunction, bytes extraData
    );

    /// @notice The callback was reached with `extraData` naming a different resolver.
    /// @dev The failure this guards is not exotic. A client resolving through the UniversalResolver
    ///      sees the UR as `sender`; a callback that checked `msg.sender`, or that trusted an address
    ///      placed in `extraData` by whoever assembled it, would accept responses minted for a
    ///      resolver it has no relationship with.
    error SenderMismatch(address provided, address expected);
    error SignatureExpired(uint64 expires, uint64 currentTime);
    error UnauthorizedSigner(address signer);
    error NoGatewayUrls();

    event SignerChanged(address indexed signer, bool allowed);
    event GatewayUrlsChanged(string[] urls);

    /// @notice The ENSIP-24 key the envelope lives under.
    string public constant ENVELOPE_KEY = "zegel.envelope.v1";

    /// @notice ENSIP-22 feature id asserting that this resolver serves a Zegel sealed envelope and
    ///         that its gateway response is signed, expiring and query-bound.
    /// @dev ENSIP-22 is a draft and reserves no ids for third parties, so this one is namespaced to
    ///      us rather than borrowed from a registry that does not exist yet.
    bytes4 public constant FEATURE_SEALED_ENVELOPE = bytes4(keccak256("zegel.sealed-envelope.v1"));

    bytes32 private constant ENVELOPE_KEY_HASH = keccak256(bytes("zegel.envelope.v1"));

    /// @notice Addresses whose signatures the callback will accept.
    mapping(address signer => bool allowed) public signers;

    /// @dev node => keccak256(key) => envelope. The on-chain path, for when the gateway is down or
    ///      deliberately bypassed. It costs the name's owner real L1 gas per byte, so it is a
    ///      fallback and not the default.
    mapping(bytes32 node => mapping(bytes32 keyHash => bytes envelope)) private _envelopes;

    string[] private _urls;

    constructor(address initialOwner, string[] memory gatewayUrls_, address[] memory initialSigners)
        Owned(initialOwner)
    {
        _setGatewayUrls(gatewayUrls_);
        for (uint256 i; i < initialSigners.length; ++i) {
            signers[initialSigners[i]] = true;
            emit SignerChanged(initialSigners[i], true);
        }
    }

    // ---------------------------------------------------------------------------------------------
    // Resolution
    // ---------------------------------------------------------------------------------------------

    /// @inheritdoc IExtendedResolver
    /// @dev `name` is carried into `callData` and therefore into the signed digest. That is the only
    ///      reason a signed response cannot be lifted from one name onto another.
    function resolve(bytes calldata name, bytes calldata request) external view returns (bytes memory) {
        if (request.length >= 4 && bytes4(request[:4]) == IDataResolver.data.selector) {
            (bytes32 node, string memory key) = abi.decode(request[4:], (bytes32, string));
            bytes memory stored = _envelopes[node][keccak256(bytes(key))];
            if (stored.length != 0) return abi.encode(stored);
        }

        bytes memory callData = abi.encodeWithSelector(IZegelGatewayService.resolve.selector, name, request);
        _offchain(callData);
    }

    /// @inheritdoc IDataResolver
    function data(bytes32 node, string calldata key) external view returns (bytes memory) {
        bytes memory stored = _envelopes[node][keccak256(bytes(key))];
        if (stored.length != 0) return stored;

        _offchain(abi.encodeWithSelector(IDataResolver.data.selector, node, key));
    }

    /// @notice ERC-3668 callback. Verifies the gateway response and returns it verbatim.
    /// @param response ABI-encoded `(bytes result, uint64 expires, bytes signature)`.
    /// @param extraData ABI-encoded `(bytes callData, address sender)`, as minted by this contract.
    function resolveWithProof(bytes calldata response, bytes calldata extraData)
        external
        view
        returns (bytes memory)
    {
        (bytes memory callData, address sender) = abi.decode(extraData, (bytes, address));
        if (sender != address(this)) revert SenderMismatch(sender, address(this));

        (bytes memory result, uint64 expires, bytes memory signature) =
            abi.decode(response, (bytes, uint64, bytes));
        if (expires < block.timestamp) revert SignatureExpired(expires, uint64(block.timestamp));

        bytes32 digest = SignatureVerifier.makeSignatureHash(sender, expires, callData, result);
        address signer = digest.recoverSigner(signature);
        if (!signers[signer]) revert UnauthorizedSigner(signer);

        return result;
    }

    /// @inheritdoc ISupportedDataKeys
    function supportedDataKeys(bytes32) external pure returns (string[] memory keys) {
        keys = new string[](1);
        keys[0] = ENVELOPE_KEY;
    }

    // ---------------------------------------------------------------------------------------------
    // Discovery
    // ---------------------------------------------------------------------------------------------

    function supportsInterface(bytes4 interfaceId) external pure returns (bool) {
        return interfaceId == 0x01ffc9a7 // ERC-165
            || interfaceId == type(IExtendedResolver).interfaceId // ENSIP-10  0x9061b923
            || interfaceId == type(IDataResolver).interfaceId // ENSIP-24  0xecbfada3
            || interfaceId == type(ISupportedDataKeys).interfaceId // ENSIP-24  0x29fb1892
            || interfaceId == type(IERC7996).interfaceId; // ERC-7996  0x582de3e7
    }

    /// @inheritdoc IERC7996
    function supportsFeature(bytes4 feature) external pure returns (bool) {
        return feature == type(IExtendedResolver).interfaceId || feature == type(IDataResolver).interfaceId
            || feature == FEATURE_SEALED_ENVELOPE;
    }

    function gatewayUrls() external view returns (string[] memory) {
        return _urls;
    }

    /// @notice The on-chain envelope for a node, or empty if resolution goes off-chain.
    function storedEnvelope(bytes32 node, string calldata key) external view returns (bytes memory) {
        return _envelopes[node][keccak256(bytes(key))];
    }

    // ---------------------------------------------------------------------------------------------
    // Administration
    // ---------------------------------------------------------------------------------------------

    function setSigner(address signer, bool allowed) external onlyOwner {
        signers[signer] = allowed;
        emit SignerChanged(signer, allowed);
    }

    function setGatewayUrls(string[] calldata urls) external onlyOwner {
        _setGatewayUrls(urls);
    }

    /// @notice Publish an envelope on chain, bypassing the gateway for that node.
    /// @dev Pass empty bytes to clear it and fall back to CCIP-Read.
    function setEnvelope(bytes32 node, bytes calldata envelope) external onlyOwner {
        _envelopes[node][ENVELOPE_KEY_HASH] = envelope;
        emit DataChanged(node, ENVELOPE_KEY, ENVELOPE_KEY, envelope);
    }

    // ---------------------------------------------------------------------------------------------

    /// @dev Always reverts. Split out so the two entry points cannot drift on the one field that
    ///      matters, `extraData`.
    function _offchain(bytes memory callData) private view {
        if (_urls.length == 0) revert NoGatewayUrls();
        revert OffchainLookup(
            address(this),
            _urls,
            callData,
            this.resolveWithProof.selector,
            abi.encode(callData, address(this))
        );
    }

    function _setGatewayUrls(string[] memory urls) private {
        _urls = urls;
        emit GatewayUrlsChanged(urls);
    }
}
