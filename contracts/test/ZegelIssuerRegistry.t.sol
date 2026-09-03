// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";

import {ZegelIssuerRegistry} from "../src/ZegelIssuerRegistry.sol";
import {IRegistry} from "../src/interfaces/IRegistry.sol";

contract ZegelIssuerRegistryTest is Test {
    ZegelIssuerRegistry internal registry;

    address internal root = makeAddr("root");
    address internal issuer = makeAddr("issuer");
    address internal delegate = makeAddr("delegate");
    address internal stranger = makeAddr("stranger");
    address internal resolverAddr = makeAddr("resolver");

    string internal constant LABEL = "acme";
    string internal constant OTHER_LABEL = "globex";
    string internal constant KEY = "zegel.envelope.v1";
    string internal constant OTHER_KEY = "com.twitter";

    // Restated locally rather than read back through a getter, so the assertions below compare the
    // contract against ENSv2's numbering instead of against itself.
    uint256 internal constant ROLE_REGISTRAR = 1 << 0;
    uint256 internal constant ROLE_UNREGISTER = 1 << 12;
    uint256 internal constant ROLE_SET_SUBREGISTRY = 1 << 20;
    uint256 internal constant ROLE_SET_RESOLVER = 1 << 24;
    uint256 internal constant ROLE_SET_DATA = 1 << 36;
    uint256 internal constant ADMIN_SHIFT = 128;
    uint256 internal constant OWNER_ROLES = ROLE_UNREGISTER | ROLE_SET_SUBREGISTRY | ROLE_SET_RESOLVER
        | ROLE_SET_DATA
        | ((ROLE_UNREGISTER | ROLE_SET_SUBREGISTRY | ROLE_SET_RESOLVER | ROLE_SET_DATA) << ADMIN_SHIFT);
    uint256 internal constant MAX_ASSIGNEES = 15;
    bytes32 internal constant ANY_PART = bytes32(0);
    uint256 internal constant ANY_NODE = 0;

    uint256 internal acme;
    uint256 internal globex;
    uint64 internal expiry;

    bytes internal envelope = bytes('{"schema":"zegel.envelope.v1"}');

    function setUp() public {
        vm.warp(1_800_000_000);
        expiry = uint64(block.timestamp + 365 days);
        registry = new ZegelIssuerRegistry(root);

        vm.prank(root);
        registry.grantRootRoles(ROLE_REGISTRAR, issuer);

        vm.startPrank(issuer);
        registry.register(LABEL, issuer, IRegistry(address(0)), resolverAddr, OWNER_ROLES, expiry);
        registry.register(OTHER_LABEL, issuer, IRegistry(address(0)), resolverAddr, OWNER_ROLES, expiry);
        vm.stopPrank();

        acme = registry.canonicalIdOf(LABEL);
        globex = registry.canonicalIdOf(OTHER_LABEL);
    }

    // ---------------------------------------------------------------------------------------------
    // Standards conformance
    // ---------------------------------------------------------------------------------------------

    function test_InterfaceIds() public view {
        assertEq(type(IRegistry).interfaceId, bytes4(0x51f67f40), "ENSv2 IRegistry");
        assertTrue(registry.supportsInterface(0x01ffc9a7));
        assertTrue(registry.supportsInterface(0x51f67f40));
        assertTrue(registry.supportsInterface(0x8f452d62));
        assertEq(registry.EAC_INTERFACE_ID(), bytes4(0x8f452d62), "ENSv2 EAC");
        assertFalse(registry.supportsInterface(0xffffffff));
    }

    function test_RegistrySelectors() public pure {
        assertEq(IRegistry.getSubregistry.selector, bytes4(0x35af6216));
        assertEq(IRegistry.getResolver.selector, bytes4(0xe4ae7d77));
        assertEq(IRegistry.getParent.selector, bytes4(0x80f76021));
    }

    /// @dev The role numbering has to be ENSv2's, or a grant reasoned about against a real
    ///      `PermissionedRegistry` would mean something different here.
    function test_RoleConstantsMatchEnsV2() public view {
        assertEq(registry.ROLE_REGISTRAR(), ROLE_REGISTRAR);
        assertEq(registry.ROLE_UNREGISTER(), ROLE_UNREGISTER);
        assertEq(registry.ROLE_SET_SUBREGISTRY(), ROLE_SET_SUBREGISTRY);
        assertEq(registry.ROLE_SET_RESOLVER(), ROLE_SET_RESOLVER);
        assertEq(registry.ROLE_SET_DATA(), ROLE_SET_DATA);
        assertEq(registry.OWNER_ROLES(), OWNER_ROLES);
        assertEq(registry.MAX_ASSIGNEES(), MAX_ASSIGNEES);
        assertEq(registry.ROOT_RESOURCE(), 0);
    }

    /// @dev `resource(0, 0)` is a hashed registry-wide wildcard, deliberately distinct from the root
    ///      resource. Conflating the two would make every wildcard grant a root grant.
    function test_WildcardResourceIsNotRootResource() public view {
        assertTrue(registry.resource(ANY_NODE, ANY_PART) != registry.ROOT_RESOURCE());
    }

    // ---------------------------------------------------------------------------------------------
    // IRegistry
    // ---------------------------------------------------------------------------------------------

    function test_GetResolverAndSubregistry() public {
        assertEq(registry.getResolver(LABEL), resolverAddr);
        assertEq(address(registry.getSubregistry(LABEL)), address(0));

        IRegistry child = IRegistry(makeAddr("child-registry"));
        vm.prank(issuer);
        registry.setSubregistry(acme, child);
        assertEq(address(registry.getSubregistry(LABEL)), address(child));
    }

    function test_SetResolver() public {
        address next = makeAddr("next-resolver");
        vm.prank(issuer);
        registry.setResolver(acme, next);
        assertEq(registry.getResolver(LABEL), next);
    }

    function test_UnregisteredLabelResolvesToNothing() public view {
        assertEq(registry.getResolver("nobody"), address(0));
        assertEq(address(registry.getSubregistry("nobody")), address(0));
    }

    /// @dev A subtree cannot outlive its registration. No zombie records.
    function test_ExpiredNameResolvesToNothing() public {
        vm.warp(expiry);
        assertEq(registry.getResolver(LABEL), address(0));
        assertEq(registry.getRecord(acme, KEY), "");
    }

    function test_SetParentIsWriteOnce() public {
        IRegistry parent = IRegistry(makeAddr("eth-registry"));

        vm.startPrank(root);
        registry.setParent(parent, "zegel");
        (IRegistry seen, string memory label) = registry.getParent();
        assertEq(address(seen), address(parent));
        assertEq(label, "zegel");

        vm.expectRevert(ZegelIssuerRegistry.ParentAlreadySet.selector);
        registry.setParent(IRegistry(makeAddr("other")), "hijack");
        vm.stopPrank();
    }

    function test_RevertWhen_StrangerSetsParent() public {
        vm.prank(stranger);
        vm.expectPartialRevert(ZegelIssuerRegistry.EACUnauthorizedAccountRoles.selector);
        registry.setParent(IRegistry(makeAddr("eth-registry")), "zegel");
    }

    // ---------------------------------------------------------------------------------------------
    // Registration
    // ---------------------------------------------------------------------------------------------

    function test_RevertWhen_StrangerRegisters() public {
        vm.prank(stranger);
        vm.expectPartialRevert(ZegelIssuerRegistry.EACUnauthorizedAccountRoles.selector);
        registry.register("mine", stranger, IRegistry(address(0)), resolverAddr, 0, expiry);
    }

    function test_RevertWhen_RegisteringLiveName() public {
        vm.prank(issuer);
        vm.expectRevert(abi.encodeWithSelector(ZegelIssuerRegistry.NameAlreadyRegistered.selector, LABEL));
        registry.register(LABEL, stranger, IRegistry(address(0)), resolverAddr, 0, expiry);
    }

    function test_RevertWhen_LabelIsEmpty() public {
        vm.prank(issuer);
        vm.expectRevert(ZegelIssuerRegistry.EmptyLabel.selector);
        registry.register("", issuer, IRegistry(address(0)), resolverAddr, 0, expiry);
    }

    /// @dev DNS wire format caps a label at 63 bytes, so a longer one could never be queried.
    function test_RevertWhen_LabelExceedsDnsLimit() public {
        string memory tooLong = new string(64);
        vm.prank(issuer);
        vm.expectRevert(abi.encodeWithSelector(ZegelIssuerRegistry.LabelTooLong.selector, uint256(64)));
        registry.register(tooLong, issuer, IRegistry(address(0)), resolverAddr, 0, expiry);
    }

    function test_RevertWhen_RegisteringWithPastExpiry() public {
        vm.prank(issuer);
        vm.expectPartialRevert(ZegelIssuerRegistry.ExpiryInPast.selector);
        registry.register("late", issuer, IRegistry(address(0)), resolverAddr, 0, uint64(block.timestamp));
    }

    function test_TokenIdCarriesTheVersionInItsLowWord() public view {
        uint256 tokenId = registry.tokenIdOf(acme);
        assertEq(registry.canonicalOf(tokenId), acme, "token id normalises back to the canonical id");
        // forge-lint: disable-next-line(unsafe-typecast)
        assertEq(uint32(acme), 0, "the canonical id has an empty low word");
        assertEq(registry.labelOf(acme), LABEL);
    }

    /// @dev Registering with an empty bitmap emancipates the name at birth: the owner holds nothing,
    ///      which is ENSv2's replacement for NameWrapper's PARENT_CANNOT_CONTROL fuse.
    function test_RegisterWithNoRolesEmancipatesTheName() public {
        vm.prank(issuer);
        registry.register("orphan", stranger, IRegistry(address(0)), resolverAddr, 0, expiry);
        uint256 orphan = registry.canonicalIdOf("orphan");

        vm.prank(stranger);
        vm.expectPartialRevert(ZegelIssuerRegistry.EACUnauthorizedAccountRoles.selector);
        registry.setRecord(orphan, KEY, envelope);
    }

    // ---------------------------------------------------------------------------------------------
    // Four-level resource scoping — the demonstration
    // ---------------------------------------------------------------------------------------------

    /// @notice Grant one address the right to write exactly one record on exactly one name.
    function test_NarrowGrantWritesExactlyOneRecordOnOneName() public {
        _grantEnvelopeRoleTo(delegate);

        vm.prank(delegate);
        registry.setRecord(acme, KEY, envelope);
        assertEq(registry.getRecord(acme, KEY), envelope);
    }

    function test_RevertWhen_NarrowGranteeWritesAnotherKey() public {
        _grantEnvelopeRoleTo(delegate);

        vm.prank(delegate);
        vm.expectPartialRevert(ZegelIssuerRegistry.EACUnauthorizedAccountRoles.selector);
        registry.setRecord(acme, OTHER_KEY, envelope);
    }

    function test_RevertWhen_NarrowGranteeWritesAnotherName() public {
        _grantEnvelopeRoleTo(delegate);

        vm.prank(delegate);
        vm.expectPartialRevert(ZegelIssuerRegistry.EACUnauthorizedAccountRoles.selector);
        registry.setRecord(globex, KEY, envelope);
    }

    function test_RevertWhen_NarrowGranteeChangesResolver() public {
        _grantEnvelopeRoleTo(delegate);

        vm.prank(delegate);
        vm.expectPartialRevert(ZegelIssuerRegistry.EACUnauthorizedAccountRoles.selector);
        registry.setResolver(acme, stranger);
    }

    function test_RevertWhen_NarrowGranteeDelegatesOnward() public {
        _grantEnvelopeRoleTo(delegate);

        // The grantee got the role but not its admin half, so the grant is a leaf.
        vm.prank(delegate);
        vm.expectPartialRevert(ZegelIssuerRegistry.EACCannotGrantRoles.selector);
        registry.grantRecordRoles(acme, KEY, ROLE_SET_DATA, stranger);
    }

    /// @dev Level three: one name, any record.
    function test_NameWideGrantWritesAnyKeyOnThatName() public {
        uint256 res = registry.resource(registry.nodeOf(acme), ANY_PART);

        vm.prank(issuer);
        registry.grantRoles(res, ROLE_SET_DATA, delegate);

        vm.startPrank(delegate);
        registry.setRecord(acme, KEY, envelope);
        registry.setRecord(acme, OTHER_KEY, "x");

        vm.expectPartialRevert(ZegelIssuerRegistry.EACUnauthorizedAccountRoles.selector);
        registry.setRecord(globex, KEY, envelope);
        vm.stopPrank();
    }

    /// @dev Level two: any name, one record type.
    function test_KeyWideGrantWritesThatKeyOnEveryName() public {
        uint256 res = registry.resource(ANY_NODE, registry.dataPart(KEY));

        vm.prank(root);
        registry.grantRoles(res, ROLE_SET_DATA, delegate);

        vm.startPrank(delegate);
        registry.setRecord(acme, KEY, envelope);
        registry.setRecord(globex, KEY, envelope);

        vm.expectPartialRevert(ZegelIssuerRegistry.EACUnauthorizedAccountRoles.selector);
        registry.setRecord(acme, OTHER_KEY, envelope);
        vm.stopPrank();
    }

    /// @dev Level one: any name, any record — a registry-wide wildcard that is still not root.
    function test_RegistryWideGrantIsNotRoot() public {
        uint256 res = registry.resource(ANY_NODE, ANY_PART);

        vm.prank(root);
        registry.grantRoles(res, ROLE_SET_DATA, delegate);

        vm.startPrank(delegate);
        registry.setRecord(acme, OTHER_KEY, envelope);
        registry.setRecord(globex, KEY, envelope);

        // Wide over records, but it confers nothing at root: registration stays closed.
        vm.expectPartialRevert(ZegelIssuerRegistry.EACUnauthorizedAccountRoles.selector);
        registry.register("theirs", delegate, IRegistry(address(0)), resolverAddr, 0, expiry);
        vm.stopPrank();

        assertFalse(registry.hasRootRoles(ROLE_REGISTRAR, delegate));
    }

    function test_RootHoldsEveryResource() public {
        vm.prank(root);
        registry.setRecord(acme, KEY, envelope);
        assertEq(registry.getRecord(acme, KEY), envelope);
    }

    // ---------------------------------------------------------------------------------------------
    // Revocation
    // ---------------------------------------------------------------------------------------------

    function test_RevokeRecordRolesEndsTheGrant() public {
        _grantEnvelopeRoleTo(delegate);
        vm.prank(delegate);
        registry.setRecord(acme, KEY, envelope);

        vm.prank(issuer);
        registry.revokeRecordRoles(acme, KEY, ROLE_SET_DATA, delegate);
        assertFalse(registry.hasScopedRoles(acme, registry.dataPart(KEY), ROLE_SET_DATA, delegate));

        vm.prank(delegate);
        vm.expectPartialRevert(ZegelIssuerRegistry.EACUnauthorizedAccountRoles.selector);
        registry.setRecord(acme, KEY, "replacement");

        // The record already written stays. Revocation is "no more writes", not "unwrite".
        assertEq(registry.getRecord(acme, KEY), envelope);
    }

    /// @notice The ENSv2 nuclear option: one write invalidates every grant on the name at once.
    function test_BumpEacVersionInvalidatesEveryGrant() public {
        _grantEnvelopeRoleTo(delegate);

        uint256 nameWide = registry.resource(registry.nodeOf(acme), ANY_PART);
        vm.prank(issuer);
        registry.grantRoles(nameWide, ROLE_SET_DATA, stranger);

        vm.prank(delegate);
        registry.setRecord(acme, KEY, envelope);

        uint256 tokenIdBefore = registry.tokenIdOf(acme);
        uint256 nodeBefore = registry.nodeOf(acme);

        vm.prank(issuer);
        registry.bumpEacVersion(acme);

        assertTrue(registry.nodeOf(acme) != nodeBefore, "node must move with the version");
        assertTrue(registry.tokenIdOf(acme) != tokenIdBefore, "token id must be regenerated");
        assertEq(registry.getEntry(acme).eacVersionId, 1);

        // Both delegations are gone, and neither had to be enumerated to end it.
        vm.prank(delegate);
        vm.expectPartialRevert(ZegelIssuerRegistry.EACUnauthorizedAccountRoles.selector);
        registry.setRecord(acme, KEY, "after");

        vm.prank(stranger);
        vm.expectPartialRevert(ZegelIssuerRegistry.EACUnauthorizedAccountRoles.selector);
        registry.setRecord(acme, OTHER_KEY, "after");

        // The owner survives, and so does the data. Only the permissions reset.
        vm.prank(issuer);
        registry.setRecord(acme, OTHER_KEY, "still mine");
        assertEq(registry.getRecord(acme, KEY), envelope);
    }

    function test_RevertWhen_StrangerBumpsEacVersion() public {
        vm.prank(stranger);
        vm.expectPartialRevert(ZegelIssuerRegistry.EACUnauthorizedAccountRoles.selector);
        registry.bumpEacVersion(acme);
    }

    /// @dev A name that lapses and is re-registered must not carry the previous holder's delegations.
    function test_ReRegistrationAfterExpiryDropsOldGrants() public {
        _grantEnvelopeRoleTo(delegate);
        vm.warp(expiry);
        uint64 renewed = uint64(block.timestamp + 30 days);

        vm.prank(issuer);
        registry.register(LABEL, stranger, IRegistry(address(0)), resolverAddr, OWNER_ROLES, renewed);

        vm.prank(delegate);
        vm.expectPartialRevert(ZegelIssuerRegistry.EACUnauthorizedAccountRoles.selector);
        registry.setRecord(acme, KEY, "after");

        vm.prank(stranger);
        registry.setRecord(acme, KEY, "new owner");
        assertEq(registry.getRecord(acme, KEY), "new owner");
    }

    function test_RevertWhen_WritingToAnExpiredName() public {
        vm.warp(expiry);
        vm.prank(issuer);
        vm.expectRevert(abi.encodeWithSelector(ZegelIssuerRegistry.NameNotRegistered.selector, acme));
        registry.setRecord(acme, KEY, envelope);
    }

    function test_UnregisterTakesTheSubtreeWithIt() public {
        _grantEnvelopeRoleTo(delegate);

        vm.prank(issuer);
        registry.unregister(acme);

        assertEq(registry.getResolver(LABEL), address(0));
        assertEq(registry.getRecord(acme, KEY), "");
        assertEq(registry.getEntry(acme).owner, address(0));

        vm.prank(delegate);
        vm.expectRevert(abi.encodeWithSelector(ZegelIssuerRegistry.NameNotRegistered.selector, acme));
        registry.setRecord(acme, KEY, envelope);
    }

    function test_RevertWhen_StrangerUnregisters() public {
        vm.prank(stranger);
        vm.expectPartialRevert(ZegelIssuerRegistry.EACUnauthorizedAccountRoles.selector);
        registry.unregister(acme);
    }

    /// @dev The label is free again afterwards, and the new holder inherits nothing.
    function test_UnregisteredLabelCanBeReRegistered() public {
        _grantEnvelopeRoleTo(delegate);

        vm.startPrank(issuer);
        registry.unregister(acme);
        registry.register(LABEL, stranger, IRegistry(address(0)), resolverAddr, OWNER_ROLES, expiry);
        vm.stopPrank();

        vm.prank(delegate);
        vm.expectPartialRevert(ZegelIssuerRegistry.EACUnauthorizedAccountRoles.selector);
        registry.setRecord(acme, KEY, envelope);

        vm.prank(stranger);
        registry.setRecord(acme, KEY, envelope);
        assertEq(registry.getRecord(acme, KEY), envelope);
    }

    function test_RecordPartsAreDistinct() public view {
        assertTrue(registry.resolverPart() != registry.subregistryPart());
        assertTrue(registry.resolverPart() != registry.dataPart(KEY));
        assertTrue(registry.dataPart(KEY) != registry.dataPart(OTHER_KEY));
        assertTrue(registry.dataPart(KEY) != ANY_PART, "no key may collide with the wildcard part");
    }

    // ---------------------------------------------------------------------------------------------
    // EAC mechanics
    // ---------------------------------------------------------------------------------------------

    function test_RevertWhen_GrantingOnRootResource() public {
        vm.prank(root);
        vm.expectRevert(ZegelIssuerRegistry.EACRootResourceNotAllowed.selector);
        registry.grantRoles(0, ROLE_SET_DATA, delegate);
    }

    function test_RevertWhen_RevokingOnRootResource() public {
        vm.prank(root);
        vm.expectRevert(ZegelIssuerRegistry.EACRootResourceNotAllowed.selector);
        registry.revokeRoles(0, ROLE_SET_DATA, delegate);
    }

    function test_RevertWhen_BitmapIsNotNybbleAligned() public {
        vm.prank(root);
        vm.expectRevert(abi.encodeWithSelector(ZegelIssuerRegistry.EACInvalidRoleBitmap.selector, uint256(2)));
        registry.grantRootRoles(2, delegate);
    }

    function test_RevertWhen_BitmapIsEmpty() public {
        vm.prank(root);
        vm.expectRevert(abi.encodeWithSelector(ZegelIssuerRegistry.EACInvalidRoleBitmap.selector, uint256(0)));
        registry.grantRootRoles(0, delegate);
    }

    function test_RevertWhen_GranteeIsZeroAddress() public {
        vm.prank(root);
        vm.expectRevert(ZegelIssuerRegistry.EACInvalidAccount.selector);
        registry.grantRootRoles(ROLE_SET_DATA, address(0));
    }

    /// @dev Revocation reports its own error, so a caller can tell a failed grant from a failed revoke.
    function test_RevertWhen_StrangerRevokesRoles() public {
        _grantEnvelopeRoleTo(delegate);

        vm.prank(stranger);
        vm.expectPartialRevert(ZegelIssuerRegistry.EACCannotRevokeRoles.selector);
        registry.revokeRecordRoles(acme, KEY, ROLE_SET_DATA, delegate);
    }

    function test_RevertWhen_StrangerRevokesRootRoles() public {
        vm.prank(stranger);
        vm.expectPartialRevert(ZegelIssuerRegistry.EACCannotRevokeRoles.selector);
        registry.revokeRootRoles(ROLE_REGISTRAR, issuer);
    }

    function test_RevertWhen_CallerLacksTheAdminRole() public {
        vm.prank(stranger);
        vm.expectPartialRevert(ZegelIssuerRegistry.EACCannotGrantRoles.selector);
        registry.grantRecordRoles(acme, KEY, ROLE_SET_DATA, delegate);
    }

    /// @dev A role is counted per resource in its own nybble, which is what caps it at 15 holders.
    function test_RoleCountIsNybblePacked() public {
        uint256 res = registry.resource(registry.nodeOf(acme), registry.dataPart(KEY));
        assertEq(registry.roleCount(res), 0);

        _grantEnvelopeRoleTo(delegate);
        assertEq(registry.roleCount(res), ROLE_SET_DATA);

        _grantEnvelopeRoleTo(stranger);
        assertEq(registry.roleCount(res), ROLE_SET_DATA * 2);

        vm.prank(issuer);
        registry.revokeRecordRoles(acme, KEY, ROLE_SET_DATA, stranger);
        assertEq(registry.roleCount(res), ROLE_SET_DATA);
    }

    function test_RevertWhen_SixteenthAssignee() public {
        for (uint256 i; i < MAX_ASSIGNEES; ++i) {
            // forge-lint: disable-next-line(unsafe-typecast)
            _grantEnvelopeRoleTo(address(uint160(0x1000 + i)));
        }

        vm.prank(issuer);
        vm.expectPartialRevert(ZegelIssuerRegistry.EACMaxAssignees.selector);
        registry.grantRecordRoles(acme, KEY, ROLE_SET_DATA, address(uint160(0x2000)));
    }

    /// @dev Re-granting a role an account already holds must not consume a second slot.
    function test_RegrantIsIdempotent() public {
        uint256 res = registry.resource(registry.nodeOf(acme), registry.dataPart(KEY));
        _grantEnvelopeRoleTo(delegate);
        _grantEnvelopeRoleTo(delegate);

        assertEq(registry.roleCount(res), ROLE_SET_DATA);
        assertEq(registry.roles(res, delegate), ROLE_SET_DATA);
    }

    function test_RevokeOfAnUnheldRoleIsANoop() public {
        uint256 res = registry.resource(registry.nodeOf(acme), registry.dataPart(KEY));

        vm.prank(issuer);
        assertFalse(registry.revokeRecordRoles(acme, KEY, ROLE_SET_DATA, delegate));
        assertEq(registry.roleCount(res), 0);
    }

    function test_RootRolesApplyEverywhere() public {
        vm.prank(root);
        registry.grantRootRoles(ROLE_SET_DATA, delegate);

        assertTrue(registry.hasRootRoles(ROLE_SET_DATA, delegate));
        assertTrue(registry.hasRoles(12345, ROLE_SET_DATA, delegate));

        vm.prank(delegate);
        registry.setRecord(globex, OTHER_KEY, envelope);
    }

    function test_RootRolesCanBeRevoked() public {
        vm.startPrank(root);
        registry.grantRootRoles(ROLE_SET_DATA, delegate);
        registry.revokeRootRoles(ROLE_SET_DATA, delegate);
        vm.stopPrank();

        assertFalse(registry.hasRootRoles(ROLE_SET_DATA, delegate));
    }

    // ---------------------------------------------------------------------------------------------
    // Fuzz
    // ---------------------------------------------------------------------------------------------

    /// @dev The narrow grant is exact: its own key on its own name, and nothing else.
    function testFuzz_NarrowGrantIsExact(string calldata otherKey, bool otherName) public {
        vm.assume(bytes(otherKey).length > 0);
        vm.assume(keccak256(bytes(otherKey)) != keccak256(bytes(KEY)));

        _grantEnvelopeRoleTo(delegate);
        uint256 target = otherName ? globex : acme;

        vm.prank(delegate);
        vm.expectPartialRevert(ZegelIssuerRegistry.EACUnauthorizedAccountRoles.selector);
        registry.setRecord(target, otherKey, envelope);
    }

    function testFuzz_OnlyRoleHoldersWrite(address caller) public {
        vm.assume(caller != root && caller != issuer);

        vm.prank(caller);
        vm.expectPartialRevert(ZegelIssuerRegistry.EACUnauthorizedAccountRoles.selector);
        registry.setRecord(acme, KEY, envelope);
    }

    /// @dev However far the version runs, the canonical id is stable and the token id keeps encoding it.
    function testFuzz_TokenIdAlwaysNormalises(uint8 bumps) public {
        bumps = uint8(bound(bumps, 1, 40));
        for (uint256 i; i < bumps; ++i) {
            vm.prank(issuer);
            registry.bumpEacVersion(acme);
        }

        assertEq(registry.canonicalOf(registry.tokenIdOf(acme)), acme);
        assertEq(registry.getEntry(acme).tokenVersionId, bumps);
    }

    /// @dev Distinct labels never collide onto one canonical id, which is what keeps the scoping real.
    function testFuzz_CanonicalIdsAreDistinct(string calldata a, string calldata b) public view {
        vm.assume(keccak256(bytes(a)) != keccak256(bytes(b)));
        assertTrue(registry.canonicalIdOf(a) != registry.canonicalIdOf(b));
    }

    function _grantEnvelopeRoleTo(address account) private {
        vm.prank(issuer);
        registry.grantRecordRoles(acme, KEY, ROLE_SET_DATA, account);
    }
}
