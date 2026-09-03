// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";

import {ZegelResolver} from "../src/ZegelResolver.sol";
import {Owned} from "../src/auth/Owned.sol";
import {IDataResolver, ISupportedDataKeys} from "../src/interfaces/IDataResolver.sol";
import {IERC7996} from "../src/interfaces/IERC7996.sol";
import {IExtendedResolver} from "../src/interfaces/IExtendedResolver.sol";
import {IZegelGatewayService} from "../src/interfaces/IZegelGatewayService.sol";
import {SignatureVerifier} from "../src/libraries/SignatureVerifier.sol";

contract ZegelResolverTest is Test {
    ZegelResolver internal resolver;

    address internal owner = makeAddr("owner");
    address internal stranger = makeAddr("stranger");

    uint256 internal signerKey;
    address internal signerAddr;
    uint256 internal rogueKey;
    address internal rogueAddr;

    /// @dev The address a client actually reaches this resolver through. Its presence in `extraData`
    ///      is the bug class the callback guard exists for.
    address internal constant UNIVERSAL_RESOLVER = 0xED73a03F19e8D849E44a39252d222c6ad5217E1e;

    bytes32 internal constant ETH_NODE = keccak256(abi.encodePacked(bytes32(0), keccak256("eth")));
    bytes32 internal aliceNode = keccak256(abi.encodePacked(ETH_NODE, keccak256("alice")));
    bytes32 internal bobNode = keccak256(abi.encodePacked(ETH_NODE, keccak256("bob")));

    string internal constant KEY = "zegel.envelope.v1";

    /// @dev A stand-in for the canonical-JSON envelope. The resolver never parses it, which is the
    ///      point, so the tests treat it as opaque bytes throughout.
    bytes internal envelope =
        bytes('{"commitment":"0xdeadbeef","referenceId":"0x01","schema":"zegel.envelope.v1"}');

    function setUp() public {
        (signerAddr, signerKey) = makeAddrAndKey("gateway-signer");
        (rogueAddr, rogueKey) = makeAddrAndKey("rogue-signer");

        string[] memory urls = new string[](1);
        urls[0] = "https://gateway.zegel.xyz/v1/{sender}/{data}.json";
        address[] memory signers = new address[](1);
        signers[0] = signerAddr;

        resolver = new ZegelResolver(owner, urls, signers);
    }

    // ---------------------------------------------------------------------------------------------
    // Standards conformance
    // ---------------------------------------------------------------------------------------------

    /// @dev These constants are quoted in the README and in the gateway. If a signature ever drifts,
    ///      resolution fails silently in clients rather than loudly here, so pin them.
    function test_InterfaceIdsMatchTheStandards() public pure {
        assertEq(type(IExtendedResolver).interfaceId, bytes4(0x9061b923), "ENSIP-10");
        assertEq(type(IDataResolver).interfaceId, bytes4(0xecbfada3), "ENSIP-24 data()");
        assertEq(type(ISupportedDataKeys).interfaceId, bytes4(0x29fb1892), "ENSIP-24 supportedDataKeys");
        assertEq(type(IERC7996).interfaceId, bytes4(0x582de3e7), "ERC-7996 / ENSIP-22");
        assertEq(ZegelResolver.OffchainLookup.selector, bytes4(0x556f1830), "ERC-3668");
        assertEq(ZegelResolver.resolveWithProof.selector, bytes4(0xf4d4d2f8), "ENS callback convention");
        assertEq(IZegelGatewayService.resolve.selector, bytes4(0x9061b923), "gateway wire selector");
    }

    function test_SupportsInterface() public view {
        assertTrue(resolver.supportsInterface(0x01ffc9a7));
        assertTrue(resolver.supportsInterface(0x9061b923));
        assertTrue(resolver.supportsInterface(0xecbfada3));
        assertTrue(resolver.supportsInterface(0x29fb1892));
        assertTrue(resolver.supportsInterface(0x582de3e7));
        assertFalse(resolver.supportsInterface(0xffffffff));
        // The legacy addr() profile is deliberately absent: this resolver serves one record type.
        assertFalse(resolver.supportsInterface(0x3b3b57de));
    }

    function test_SupportsFeature() public view {
        assertTrue(resolver.supportsFeature(0x9061b923));
        assertTrue(resolver.supportsFeature(0xecbfada3));
        assertTrue(resolver.supportsFeature(resolver.FEATURE_SEALED_ENVELOPE()));
        assertFalse(resolver.supportsFeature(0xdeadbeef));
    }

    function test_SupportedDataKeys() public view {
        string[] memory keys = resolver.supportedDataKeys(aliceNode);
        assertEq(keys.length, 1);
        assertEq(keys[0], KEY);
        assertEq(resolver.ENVELOPE_KEY(), KEY);
    }

    // ---------------------------------------------------------------------------------------------
    // The offchain lookup
    // ---------------------------------------------------------------------------------------------

    function test_ResolveRevertsWithOffchainLookup() public view {
        bytes memory name = _dnsEncode("alice.eth");
        bytes memory request = abi.encodeCall(IDataResolver.data, (aliceNode, KEY));

        (
            address sender,
            string[] memory urls,
            bytes memory callData,
            bytes4 callback,
            bytes memory extraData
        ) = _catchOffchainLookup(abi.encodeCall(IExtendedResolver.resolve, (name, request)));

        assertEq(sender, address(resolver), "sender must be the reverting contract");
        assertEq(urls.length, 1);
        assertEq(urls[0], "https://gateway.zegel.xyz/v1/{sender}/{data}.json");
        assertEq(callback, ZegelResolver.resolveWithProof.selector);
        assertEq(callData, abi.encodeWithSelector(IZegelGatewayService.resolve.selector, name, request));

        (bytes memory echoedCallData, address echoedSender) = abi.decode(extraData, (bytes, address));
        assertEq(echoedCallData, callData);
        assertEq(echoedSender, address(resolver), "extraData must carry the resolver, not the caller");
    }

    function test_DataRevertsWithOffchainLookup() public view {
        (address sender,, bytes memory callData, bytes4 callback,) =
            _catchOffchainLookup(abi.encodeCall(IDataResolver.data, (aliceNode, KEY)));

        assertEq(sender, address(resolver));
        assertEq(callback, ZegelResolver.resolveWithProof.selector);
        assertEq(callData, abi.encodeWithSelector(IDataResolver.data.selector, aliceNode, KEY));
    }

    function test_RevertWhen_NoGatewayUrls() public {
        vm.prank(owner);
        resolver.setGatewayUrls(new string[](0));

        vm.expectRevert(ZegelResolver.NoGatewayUrls.selector);
        resolver.data(aliceNode, KEY);
    }

    // ---------------------------------------------------------------------------------------------
    // The callback
    // ---------------------------------------------------------------------------------------------

    function test_ResolveWithProof_DataPath() public view {
        bytes memory callData = abi.encodeWithSelector(IDataResolver.data.selector, aliceNode, KEY);
        // A direct data() query returns `bytes`, so the gateway hands back the envelope itself.
        bytes memory result = envelope;

        bytes memory out = resolver.resolveWithProof(
            _response(signerKey, address(resolver), _soon(), callData, result), _extraData(callData)
        );
        assertEq(out, envelope);
    }

    function test_ResolveWithProof_WildcardPath() public view {
        bytes memory name = _dnsEncode("alice.eth");
        bytes memory request = abi.encodeCall(IDataResolver.data, (aliceNode, KEY));
        bytes memory callData = abi.encodeWithSelector(IZegelGatewayService.resolve.selector, name, request);
        // resolve() returns the ABI-encoded return of the inner call, so this layer is wrapped once more.
        bytes memory result = abi.encode(envelope);

        bytes memory out = resolver.resolveWithProof(
            _response(signerKey, address(resolver), _soon(), callData, result), _extraData(callData)
        );
        assertEq(abi.decode(out, (bytes)), envelope);
    }

    /// @notice The single most common bug in offchain resolvers.
    /// @dev Through the UniversalResolver a client observes the UR as `sender` and will happily build
    ///      `extraData` naming it. A callback that trusted that field would verify the signature
    ///      against the wrong target and accept responses minted for a contract it does not control.
    function test_RevertWhen_SenderIsNotThis() public {
        bytes memory callData = abi.encodeWithSelector(IDataResolver.data.selector, aliceNode, KEY);
        bytes memory extraData = abi.encode(callData, UNIVERSAL_RESOLVER);

        vm.expectRevert(
            abi.encodeWithSelector(
                ZegelResolver.SenderMismatch.selector, UNIVERSAL_RESOLVER, address(resolver)
            )
        );
        resolver.resolveWithProof(
            _response(signerKey, UNIVERSAL_RESOLVER, _soon(), callData, envelope), extraData
        );
    }

    function test_RevertWhen_SenderIsAnotherResolver() public {
        string[] memory urls = new string[](1);
        urls[0] = "https://gateway.zegel.xyz/v1/{sender}/{data}.json";
        address[] memory signers = new address[](1);
        signers[0] = signerAddr;
        ZegelResolver other = new ZegelResolver(owner, urls, signers);

        bytes memory callData = abi.encodeWithSelector(IDataResolver.data.selector, aliceNode, KEY);

        vm.expectRevert(
            abi.encodeWithSelector(ZegelResolver.SenderMismatch.selector, address(other), address(resolver))
        );
        resolver.resolveWithProof(
            _response(signerKey, address(other), _soon(), callData, envelope),
            abi.encode(callData, address(other))
        );
    }

    /// @dev Even with `extraData` corrected to name this resolver, a response minted for a sibling
    ///      resolver that trusts the same signer must not verify: the target is inside the digest.
    function test_RevertWhen_ResponseMintedForAnotherResolver() public {
        address otherResolver = makeAddr("other-resolver");
        bytes memory callData = abi.encodeWithSelector(IDataResolver.data.selector, aliceNode, KEY);

        vm.expectPartialRevert(ZegelResolver.UnauthorizedSigner.selector);
        resolver.resolveWithProof(
            _response(signerKey, otherResolver, _soon(), callData, envelope), _extraData(callData)
        );
    }

    function test_RevertWhen_SignatureExpired() public {
        vm.warp(1_800_000_000);
        bytes memory callData = abi.encodeWithSelector(IDataResolver.data.selector, aliceNode, KEY);
        uint64 expires = uint64(block.timestamp) - 1;

        vm.expectRevert(
            abi.encodeWithSelector(ZegelResolver.SignatureExpired.selector, expires, uint64(block.timestamp))
        );
        resolver.resolveWithProof(
            _response(signerKey, address(resolver), expires, callData, envelope), _extraData(callData)
        );
    }

    /// @dev A response is good up to and including its expiry second, and dead the next block.
    function test_ExpiryBoundaryIsInclusive() public {
        vm.warp(1_800_000_000);
        bytes memory callData = abi.encodeWithSelector(IDataResolver.data.selector, aliceNode, KEY);
        uint64 expires = uint64(block.timestamp);
        bytes memory response = _response(signerKey, address(resolver), expires, callData, envelope);

        assertEq(resolver.resolveWithProof(response, _extraData(callData)), envelope);

        vm.warp(block.timestamp + 1);
        vm.expectPartialRevert(ZegelResolver.SignatureExpired.selector);
        resolver.resolveWithProof(response, _extraData(callData));
    }

    function test_RevertWhen_SignerNotAllowlisted() public {
        bytes memory callData = abi.encodeWithSelector(IDataResolver.data.selector, aliceNode, KEY);

        vm.expectRevert(abi.encodeWithSelector(ZegelResolver.UnauthorizedSigner.selector, rogueAddr));
        resolver.resolveWithProof(
            _response(rogueKey, address(resolver), _soon(), callData, envelope), _extraData(callData)
        );
    }

    function test_RevertWhen_SignerRevoked() public {
        bytes memory callData = abi.encodeWithSelector(IDataResolver.data.selector, aliceNode, KEY);
        bytes memory response = _response(signerKey, address(resolver), _soon(), callData, envelope);
        assertEq(resolver.resolveWithProof(response, _extraData(callData)), envelope);

        vm.prank(owner);
        resolver.setSigner(signerAddr, false);

        vm.expectRevert(abi.encodeWithSelector(ZegelResolver.UnauthorizedSigner.selector, signerAddr));
        resolver.resolveWithProof(response, _extraData(callData));
    }

    /// @notice Query binding. A signed response is a bearer token, but only for the query it answers.
    function test_RevertWhen_ReplayedAgainstDifferentNode() public {
        bytes memory aliceCallData = abi.encodeWithSelector(IDataResolver.data.selector, aliceNode, KEY);
        bytes memory bobCallData = abi.encodeWithSelector(IDataResolver.data.selector, bobNode, KEY);

        bytes memory response = _response(signerKey, address(resolver), _soon(), aliceCallData, envelope);
        // Alice's response is genuinely valid for Alice.
        assertEq(resolver.resolveWithProof(response, _extraData(aliceCallData)), envelope);

        // Lifting it onto Bob's query changes the digest, so recovery yields a stranger.
        vm.expectPartialRevert(ZegelResolver.UnauthorizedSigner.selector);
        resolver.resolveWithProof(response, _extraData(bobCallData));
    }

    function test_RevertWhen_ReplayedAgainstDifferentKey() public {
        bytes memory callData = abi.encodeWithSelector(IDataResolver.data.selector, aliceNode, KEY);
        bytes memory otherKeyCallData =
            abi.encodeWithSelector(IDataResolver.data.selector, aliceNode, "zegel.envelope.v2");

        bytes memory response = _response(signerKey, address(resolver), _soon(), callData, envelope);

        vm.expectPartialRevert(ZegelResolver.UnauthorizedSigner.selector);
        resolver.resolveWithProof(response, _extraData(otherKeyCallData));
    }

    function test_RevertWhen_ResultTampered() public {
        bytes memory callData = abi.encodeWithSelector(IDataResolver.data.selector, aliceNode, KEY);
        (, uint64 expires, bytes memory signature) = abi.decode(
            _response(signerKey, address(resolver), _soon(), callData, envelope), (bytes, uint64, bytes)
        );

        bytes memory forged = abi.encode(bytes('{"commitment":"0x00"}'), expires, signature);
        vm.expectPartialRevert(ZegelResolver.UnauthorizedSigner.selector);
        resolver.resolveWithProof(forged, _extraData(callData));
    }

    function test_RevertWhen_ExpiryExtended() public {
        bytes memory callData = abi.encodeWithSelector(IDataResolver.data.selector, aliceNode, KEY);
        (bytes memory result,, bytes memory signature) = abi.decode(
            _response(signerKey, address(resolver), _soon(), callData, envelope), (bytes, uint64, bytes)
        );

        bytes memory forged = abi.encode(result, type(uint64).max, signature);
        vm.expectPartialRevert(ZegelResolver.UnauthorizedSigner.selector);
        resolver.resolveWithProof(forged, _extraData(callData));
    }

    function test_RevertWhen_SignatureMalleable() public {
        bytes memory callData = abi.encodeWithSelector(IDataResolver.data.selector, aliceNode, KEY);
        uint64 expires = _soon();
        bytes32 digest = SignatureVerifier.makeSignatureHash(address(resolver), expires, callData, envelope);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(signerKey, digest);

        // The mirrored signature recovers the same key on a naive verifier.
        uint256 order = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141;
        bytes32 flippedS = bytes32(order - uint256(s));
        uint8 flippedV = v == 27 ? 28 : 27;

        bytes memory forged = abi.encode(envelope, expires, abi.encodePacked(r, flippedS, flippedV));
        vm.expectRevert(SignatureVerifier.MalleableSignature.selector);
        resolver.resolveWithProof(forged, _extraData(callData));
    }

    function test_RevertWhen_SignatureWrongLength() public {
        bytes memory callData = abi.encodeWithSelector(IDataResolver.data.selector, aliceNode, KEY);
        bytes memory forged = abi.encode(envelope, _soon(), hex"1234");

        vm.expectRevert(SignatureVerifier.MalformedSignature.selector);
        resolver.resolveWithProof(forged, _extraData(callData));
    }

    function test_RevertWhen_SignatureRecoveryIdInvalid() public {
        bytes memory callData = abi.encodeWithSelector(IDataResolver.data.selector, aliceNode, KEY);
        uint64 expires = _soon();
        bytes32 digest = SignatureVerifier.makeSignatureHash(address(resolver), expires, callData, envelope);
        (, bytes32 r, bytes32 s) = vm.sign(signerKey, digest);

        bytes memory forged = abi.encode(envelope, expires, abi.encodePacked(r, s, uint8(0)));
        vm.expectRevert(SignatureVerifier.MalformedSignature.selector);
        resolver.resolveWithProof(forged, _extraData(callData));
    }

    // ---------------------------------------------------------------------------------------------
    // The on-chain fallback
    // ---------------------------------------------------------------------------------------------

    function test_OnChainEnvelopeShortCircuitsData() public {
        vm.prank(owner);
        resolver.setEnvelope(aliceNode, envelope);

        assertEq(resolver.data(aliceNode, KEY), envelope);
        assertEq(resolver.storedEnvelope(aliceNode, KEY), envelope);
        // A different key on the same node still goes off-chain.
        _catchOffchainLookup(abi.encodeCall(IDataResolver.data, (aliceNode, "other")));
    }

    function test_OnChainEnvelopeShortCircuitsResolve() public {
        vm.prank(owner);
        resolver.setEnvelope(aliceNode, envelope);

        bytes memory out =
            resolver.resolve(_dnsEncode("alice.eth"), abi.encodeCall(IDataResolver.data, (aliceNode, KEY)));
        assertEq(abi.decode(out, (bytes)), envelope);
    }

    function test_ClearingEnvelopeRestoresOffchainPath() public {
        vm.startPrank(owner);
        resolver.setEnvelope(aliceNode, envelope);
        resolver.setEnvelope(aliceNode, "");
        vm.stopPrank();

        _catchOffchainLookup(abi.encodeCall(IDataResolver.data, (aliceNode, KEY)));
    }

    /// @dev A `resolve()` carrying a profile this resolver does not serve must still hand off to the
    ///      gateway rather than answering wrongly.
    function test_ResolveOfUnknownProfileGoesOffchain() public view {
        bytes memory request = abi.encodeWithSelector(bytes4(0x3b3b57de), aliceNode); // addr(bytes32)
        (,, bytes memory callData,,) = _catchOffchainLookup(
            abi.encodeCall(IExtendedResolver.resolve, (_dnsEncode("alice.eth"), request))
        );
        assertEq(
            callData,
            abi.encodeWithSelector(IZegelGatewayService.resolve.selector, _dnsEncode("alice.eth"), request)
        );
    }

    // ---------------------------------------------------------------------------------------------
    // Administration
    // ---------------------------------------------------------------------------------------------

    function test_RevertWhen_StrangerSetsSigner() public {
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(Owned.Unauthorized.selector, stranger));
        resolver.setSigner(rogueAddr, true);
    }

    function test_RevertWhen_StrangerSetsGatewayUrls() public {
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(Owned.Unauthorized.selector, stranger));
        resolver.setGatewayUrls(new string[](0));
    }

    function test_RevertWhen_StrangerSetsEnvelope() public {
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(Owned.Unauthorized.selector, stranger));
        resolver.setEnvelope(aliceNode, envelope);
    }

    function test_SetGatewayUrls() public {
        string[] memory urls = new string[](2);
        urls[0] = "https://a.example/{sender}/{data}.json";
        urls[1] = "https://b.example/{sender}/{data}.json";

        vm.prank(owner);
        resolver.setGatewayUrls(urls);

        (, string[] memory seen,,,) =
            _catchOffchainLookup(abi.encodeCall(IDataResolver.data, (aliceNode, KEY)));
        assertEq(seen.length, 2);
        assertEq(seen[1], urls[1]);
    }

    function test_GatewayUrlsGetter() public view {
        string[] memory urls = resolver.gatewayUrls();
        assertEq(urls.length, 1);
        assertEq(urls[0], "https://gateway.zegel.xyz/v1/{sender}/{data}.json");
    }

    function test_RevertWhen_DeployedWithNoOwner() public {
        vm.expectRevert(abi.encodeWithSelector(Owned.Unauthorized.selector, address(0)));
        new ZegelResolver(address(0), new string[](0), new address[](0));
    }

    /// @dev A signature that is well formed but recovers to nothing must be refused explicitly rather
    ///      than falling through to an allowlist lookup on the zero address.
    function test_RevertWhen_SignatureRecoversToZero() public {
        bytes memory callData = abi.encodeWithSelector(IDataResolver.data.selector, aliceNode, KEY);
        bytes memory forged =
            abi.encode(envelope, _soon(), abi.encodePacked(bytes32(0), bytes32(uint256(1)), uint8(27)));

        vm.expectRevert(SignatureVerifier.MalformedSignature.selector);
        resolver.resolveWithProof(forged, _extraData(callData));
    }

    function test_OwnershipIsTwoStep() public {
        address next = makeAddr("next-owner");

        vm.prank(owner);
        resolver.transferOwnership(next);
        assertEq(resolver.owner(), owner, "not transferred until accepted");

        vm.prank(next);
        resolver.acceptOwnership();
        assertEq(resolver.owner(), next);
        assertEq(resolver.pendingOwner(), address(0));
    }

    function test_RevertWhen_StrangerAcceptsOwnership() public {
        vm.prank(owner);
        resolver.transferOwnership(makeAddr("next-owner"));

        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(Owned.NotPendingOwner.selector, stranger));
        resolver.acceptOwnership();
    }

    // ---------------------------------------------------------------------------------------------
    // Fuzz
    // ---------------------------------------------------------------------------------------------

    /// @dev Any key that is not on the allowlist is refused, whatever it signs.
    function testFuzz_UnauthorizedSignerRejected(uint256 key) public {
        key = bound(key, 1, 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364140);
        vm.assume(vm.addr(key) != signerAddr);

        bytes memory callData = abi.encodeWithSelector(IDataResolver.data.selector, aliceNode, KEY);
        vm.expectRevert(abi.encodeWithSelector(ZegelResolver.UnauthorizedSigner.selector, vm.addr(key)));
        resolver.resolveWithProof(
            _response(key, address(resolver), _soon(), callData, envelope), _extraData(callData)
        );
    }

    /// @dev Query binding holds for every pair of distinct nodes, not just the two hand-picked above.
    function testFuzz_QueryBindingHoldsAcrossNodes(bytes32 nodeA, bytes32 nodeB, bytes memory payload)
        public
    {
        vm.assume(nodeA != nodeB);

        bytes memory callDataA = abi.encodeWithSelector(IDataResolver.data.selector, nodeA, KEY);
        bytes memory callDataB = abi.encodeWithSelector(IDataResolver.data.selector, nodeB, KEY);
        bytes memory response = _response(signerKey, address(resolver), _soon(), callDataA, payload);

        assertEq(resolver.resolveWithProof(response, _extraData(callDataA)), payload);

        vm.expectPartialRevert(ZegelResolver.UnauthorizedSigner.selector);
        resolver.resolveWithProof(response, _extraData(callDataB));
    }

    /// @dev No `extraData` naming anything but this contract is ever accepted, however well-formed.
    function testFuzz_SenderMismatchRejected(address claimed) public {
        vm.assume(claimed != address(resolver));

        bytes memory callData = abi.encodeWithSelector(IDataResolver.data.selector, aliceNode, KEY);
        vm.expectRevert(
            abi.encodeWithSelector(ZegelResolver.SenderMismatch.selector, claimed, address(resolver))
        );
        resolver.resolveWithProof(
            _response(signerKey, claimed, _soon(), callData, envelope), abi.encode(callData, claimed)
        );
    }

    function testFuzz_ExpiryIsEnforced(uint64 expires) public {
        vm.warp(1_800_000_000);
        bytes memory callData = abi.encodeWithSelector(IDataResolver.data.selector, aliceNode, KEY);
        bytes memory response = _response(signerKey, address(resolver), expires, callData, envelope);

        if (expires < block.timestamp) {
            vm.expectPartialRevert(ZegelResolver.SignatureExpired.selector);
            resolver.resolveWithProof(response, _extraData(callData));
        } else {
            assertEq(resolver.resolveWithProof(response, _extraData(callData)), envelope);
        }
    }

    /// @dev Whatever the gateway signs comes back byte-identical. The resolver is a pipe, not a parser.
    function testFuzz_ResultIsOpaque(bytes memory payload) public view {
        bytes memory callData = abi.encodeWithSelector(IDataResolver.data.selector, aliceNode, KEY);
        assertEq(
            resolver.resolveWithProof(
                _response(signerKey, address(resolver), _soon(), callData, payload), _extraData(callData)
            ),
            payload
        );
    }

    // ---------------------------------------------------------------------------------------------
    // Helpers
    // ---------------------------------------------------------------------------------------------

    function _soon() internal view returns (uint64) {
        return uint64(block.timestamp + 300);
    }

    function _extraData(bytes memory callData) internal view returns (bytes memory) {
        return abi.encode(callData, address(resolver));
    }

    function _response(
        uint256 key,
        address target,
        uint64 expires,
        bytes memory callData,
        bytes memory result
    ) internal pure returns (bytes memory) {
        bytes32 digest = SignatureVerifier.makeSignatureHash(target, expires, callData, result);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, digest);
        return abi.encode(result, expires, abi.encodePacked(r, s, v));
    }

    function _catchOffchainLookup(bytes memory call)
        internal
        view
        returns (
            address sender,
            string[] memory urls,
            bytes memory callData,
            bytes4 callback,
            bytes memory extraData
        )
    {
        (bool ok, bytes memory err) = address(resolver).staticcall(call);
        assertFalse(ok, "expected OffchainLookup");
        // Truncating to the leading selector is the intent.
        // forge-lint: disable-next-line(unsafe-typecast)
        assertEq(bytes4(err), ZegelResolver.OffchainLookup.selector);

        bytes memory args = new bytes(err.length - 4);
        for (uint256 i; i < args.length; ++i) {
            args[i] = err[i + 4];
        }
        return abi.decode(args, (address, string[], bytes, bytes4, bytes));
    }

    /// @dev DNS wire format: each label prefixed with its length, terminated by a zero byte.
    function _dnsEncode(string memory name) internal pure returns (bytes memory out) {
        bytes memory n = bytes(name);
        out = new bytes(n.length + 2);
        uint256 lengthSlot = 0;
        uint256 cursor = 1;
        uint8 labelLength = 0;

        for (uint256 i; i < n.length; ++i) {
            if (n[i] == ".") {
                out[lengthSlot] = bytes1(labelLength);
                lengthSlot = cursor;
                cursor += 1;
                labelLength = 0;
            } else {
                out[cursor] = n[i];
                cursor += 1;
                labelLength += 1;
            }
        }
        out[lengthSlot] = bytes1(labelLength);
        out[cursor] = 0x00;
    }
}
