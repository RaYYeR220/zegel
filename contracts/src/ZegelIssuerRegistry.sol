// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IEnhancedAccessControl} from "./interfaces/IEnhancedAccessControl.sol";
import {IRegistry} from "./interfaces/IRegistry.sol";

/// @title ZegelIssuerRegistry
/// @notice An ENSv2 subregistry of Zegel issuers, for Sepolia, that hangs off a `PermissionedRegistry`
///         and demonstrates the thing ENSv2 can do that v1 cannot: **delegate the right to write one
///         specific record on one specific name, and take it back provably.**
///
/// @dev ## Why this exists
///
/// Zegel's whole product is a reference you can withdraw. In v1 the finest grain of delegation is
/// `setApprovalForAll` or an operator on a whole node - hand someone the ability to publish a
/// reference and you have handed them the ability to publish anything under that name, forever, until
/// you notice. ENSv2's Enhanced Access Control makes the grant as narrow as the act: an issuing agent
/// gets `ROLE_SET_DATA` on `resource(node, dataPart("zegel.envelope.v1"))` and nothing else. It cannot
/// change the resolver, cannot touch a second key, cannot touch a second name.
///
/// ## Four-level resource scoping
///
/// A resource is `keccak256(node, part)`. Zeroing either half widens the grant, which gives exactly
/// four levels, checked in `_hasScopedRoles`:
///
/// | resource            | grants                             |
/// |---------------------|------------------------------------|
/// | `(0, 0)`            | any name, any record               |
/// | `(0, part)`         | any name, one record type          |
/// | `(node, 0)`         | one name, any record               |
/// | `(node, part)`      | one name, one specific record      |
///
/// Note that `resource(0, 0)` is *not* `ROOT_RESOURCE`. Root is the literal id `0` and is OR'd into
/// every check; `resource(0, 0)` is a hashed, registry-wide wildcard that root can hand out and take
/// back without surrendering root itself.
///
/// ## Provable revocation
///
/// `node` is derived from the entry's `eacVersionId`, so bumping that version moves every resource
/// belonging to the name and makes every previously granted role unreachable in one write - the
/// ENSv2 pattern, without needing to enumerate grantees. The same call regenerates `tokenVersionId`,
/// so the token id changes too. **Never cache a token id**, and, as a 2026 ENSv2 winner learned the
/// hard way, never bind an external guardian to a token id either: bind it to the resource, or it
/// breaks quietly the first time a role changes.
///
/// ## Roles
///
/// The role numbering is ENSv2's. Registry-level roles come from `RegistryRolesLib`. The record role
/// borrows `ROLE_SET_DATA` from `PermissionedResolverLib` rather than `RegistryRolesLib`'s `ROLE_SET_URI`,
/// which shares the same nybble - records are what this registry scopes, and it has no `setUri`.
contract ZegelIssuerRegistry is IRegistry, IEnhancedAccessControl {
    // --- EAC errors. Names and selectors match ENSv2's `IEnhancedAccessControl`. --------------------
    error EACUnauthorizedAccountRoles(uint256 resource, uint256 roleBitmap, address account);
    error EACCannotGrantRoles(uint256 resource, uint256 roleBitmap, address account);
    error EACCannotRevokeRoles(uint256 resource, uint256 roleBitmap, address account);
    error EACRootResourceNotAllowed();
    error EACMaxAssignees(uint256 resource, uint256 roleBitmap);
    error EACInvalidRoleBitmap(uint256 roleBitmap);
    error EACInvalidAccount();

    // --- Registry errors ---------------------------------------------------------------------------
    error NameAlreadyRegistered(string label);
    error NameNotRegistered(uint256 canonicalId);
    error EmptyLabel();
    error LabelTooLong(uint256 length);
    error ExpiryInPast(uint64 expiry, uint64 currentTime);
    error ParentAlreadySet();

    event Registered(uint256 indexed tokenId, string label, address indexed owner, uint64 expiry);
    event TokenResource(uint256 indexed tokenId, uint256 indexed resource);
    event ResolverChanged(uint256 indexed canonicalId, address resolver);
    event SubregistryChanged(uint256 indexed canonicalId, IRegistry subregistry);
    event RecordChanged(uint256 indexed canonicalId, string indexed indexedKey, string key, bytes value);
    event EacVersionBumped(uint256 indexed canonicalId, uint32 previousVersion, uint32 newVersion);
    event Unregistered(uint256 indexed canonicalId, string label);
    event ParentSet(IRegistry parent, string label);

    /// @notice The published ENSv2 `IEnhancedAccessControl` id.
    /// @dev Taken from the live Sepolia deployment rather than recomputed: the deployed interface has
    ///      members beyond the documented set, so `type(IEnhancedAccessControl).interfaceId` over our
    ///      declaration would not reproduce it. `RootRegistry` and `ETHRegistry` on Sepolia both
    ///      answer `supportsInterface(0x8f452d62)` with true.
    bytes4 public constant EAC_INTERFACE_ID = 0x8f452d62;

    // --- Role constants, ENSv2 numbering -----------------------------------------------------------
    uint256 public constant ROLE_REGISTRAR = 1 << 0;
    uint256 public constant ROLE_UNREGISTER = 1 << 12;
    uint256 public constant ROLE_SET_SUBREGISTRY = 1 << 20;
    uint256 public constant ROLE_SET_RESOLVER = 1 << 24;
    uint256 public constant ROLE_SET_DATA = 1 << 36;

    /// @notice Everything a name owner needs to run their own name, plus the admin half so they can
    ///         delegate any of it onward.
    uint256 public constant OWNER_ROLES = ROLE_UNREGISTER | ROLE_SET_SUBREGISTRY | ROLE_SET_RESOLVER
        | ROLE_SET_DATA
        | ((ROLE_UNREGISTER | ROLE_SET_SUBREGISTRY | ROLE_SET_RESOLVER | ROLE_SET_DATA) << ADMIN_SHIFT);

    /// @dev Enforced structurally rather than by comparison: the per-resource counter gives each role
    ///      one nybble, and a nybble cannot hold sixteen.
    uint256 public constant MAX_ASSIGNEES = 15;

    /// @dev A role's admin sits 128 bits above it.
    uint256 private constant ADMIN_SHIFT = 128;
    /// @dev Low bit of every nybble. A valid role bitmap is a subset of this.
    uint256 private constant NYBBLE_LOW_BITS =
        0x1111111111111111111111111111111111111111111111111111111111111111;
    // forge-lint: disable-next-line(incorrect-shift)
    uint256 private constant LOW_HALF = (1 << ADMIN_SHIFT) - 1;

    /// @dev `part` sentinel meaning "any record".
    bytes32 public constant ANY_PART = bytes32(0);
    /// @dev `node` sentinel meaning "any name".
    uint256 public constant ANY_NODE = 0;

    bytes32 private constant RESOLVER_PART = keccak256("registry.resolver");
    bytes32 private constant SUBREGISTRY_PART = keccak256("registry.subregistry");
    bytes32 private constant DATA_PART_DOMAIN = keccak256("registry.data");

    /// @dev Mirrors ENSv2's registry entry. `eacVersionId` scopes every resource for the name;
    ///      `tokenVersionId` occupies the low 32 bits of the token id.
    struct Entry {
        uint32 eacVersionId;
        uint32 tokenVersionId;
        IRegistry subregistry;
        uint64 expiry;
        address resolver;
        address owner;
    }

    mapping(uint256 canonicalId => Entry) private _entries;
    mapping(uint256 canonicalId => string label) private _labels;
    mapping(uint256 canonicalId => mapping(bytes32 keyHash => bytes value)) private _records;

    mapping(uint256 resource => mapping(address account => uint256 roleBitmap)) private _roles;
    mapping(uint256 resource => uint256 packedCounts) private _roleCounts;

    IRegistry private _parent;
    string private _parentLabel;

    /// @param root The address seeded with root roles: registrar plus the admin half of everything.
    constructor(address root) {
        if (root == address(0)) revert EACInvalidAccount();
        uint256 bitmap = ROLE_REGISTRAR | (ROLE_REGISTRAR << ADMIN_SHIFT) | OWNER_ROLES;
        _setRoles(ROOT_RESOURCE_ID, bitmap, root, true);
    }

    // ---------------------------------------------------------------------------------------------
    // IRegistry
    // ---------------------------------------------------------------------------------------------

    /// @inheritdoc IRegistry
    /// @dev An expired name resolves to nothing. A subtree cannot outlive its parent, so there are no
    ///      zombie records left behind by a lapsed registration.
    function getSubregistry(string calldata label) external view returns (IRegistry) {
        Entry storage e = _entries[canonicalIdOf(label)];
        if (e.expiry <= block.timestamp) return IRegistry(address(0));
        return e.subregistry;
    }

    /// @inheritdoc IRegistry
    function getResolver(string calldata label) external view returns (address) {
        Entry storage e = _entries[canonicalIdOf(label)];
        if (e.expiry <= block.timestamp) return address(0);
        return e.resolver;
    }

    /// @inheritdoc IRegistry
    function getParent() external view returns (IRegistry parent, string memory label) {
        return (_parent, _parentLabel);
    }

    /// @notice Record where this registry hangs in the ENSv2 tree.
    /// @dev Write-once. The parent is what an ENSv2 client walks to prove this registry is reachable
    ///      from the root, so letting it be rewritten later would let a registrar relocate a subtree
    ///      under a name its registrants never agreed to.
    function setParent(IRegistry parent, string calldata label) external {
        if (!hasRootRoles(ROLE_REGISTRAR, msg.sender)) {
            revert EACUnauthorizedAccountRoles(ROOT_RESOURCE_ID, ROLE_REGISTRAR, msg.sender);
        }
        if (address(_parent) != address(0)) revert ParentAlreadySet();
        _parent = parent;
        _parentLabel = label;
        emit ParentSet(parent, label);
    }

    // ---------------------------------------------------------------------------------------------
    // Registration
    // ---------------------------------------------------------------------------------------------

    /// @notice Register an issuer name.
    /// @param roleBitmap Roles granted to `owner` at the name level, `resource(node, ANY_PART)`. Pass
    ///        `OWNER_ROLES` for a normal registration, or `0` to emancipate the name at birth: the
    ///        owner holds nothing, so only root can ever write to it.
    /// @return tokenId `canonicalId | tokenVersionId`. Do not cache it.
    function register(
        string calldata label,
        address owner,
        IRegistry subregistry,
        address resolver,
        uint256 roleBitmap,
        uint64 expiry
    ) external returns (uint256 tokenId) {
        if (!hasRootRoles(ROLE_REGISTRAR, msg.sender)) {
            revert EACUnauthorizedAccountRoles(ROOT_RESOURCE_ID, ROLE_REGISTRAR, msg.sender);
        }
        if (owner == address(0)) revert EACInvalidAccount();
        uint256 labelLength = bytes(label).length;
        if (labelLength == 0) revert EmptyLabel();
        // DNS wire format caps a single label at 63 bytes; a longer one could never be queried.
        if (labelLength > 63) revert LabelTooLong(labelLength);
        if (expiry <= block.timestamp) revert ExpiryInPast(expiry, uint64(block.timestamp));

        uint256 canonicalId = canonicalIdOf(label);
        Entry storage e = _entries[canonicalId];
        if (e.expiry > block.timestamp) revert NameAlreadyRegistered(label);

        // A re-registration after expiry must not inherit the previous holder's delegations.
        if (e.expiry != 0) {
            unchecked {
                ++e.eacVersionId;
                ++e.tokenVersionId;
            }
        }

        e.owner = owner;
        e.expiry = expiry;
        e.resolver = resolver;
        e.subregistry = subregistry;
        _labels[canonicalId] = label;

        if (roleBitmap != 0) {
            _setRoles(resource(nodeOf(canonicalId), ANY_PART), roleBitmap, owner, true);
        }

        tokenId = canonicalId | e.tokenVersionId;
        emit Registered(tokenId, label, owner, expiry);
        emit TokenResource(tokenId, resource(nodeOf(canonicalId), ANY_PART));
    }

    // ---------------------------------------------------------------------------------------------
    // Scoped writes. Each one authorises against the four-level resource ladder.
    // ---------------------------------------------------------------------------------------------

    function setResolver(uint256 anyId, address resolver) external {
        uint256 canonicalId = _requireRegistered(anyId);
        _authorize(canonicalId, RESOLVER_PART, ROLE_SET_RESOLVER);
        _entries[canonicalId].resolver = resolver;
        emit ResolverChanged(canonicalId, resolver);
    }

    function setSubregistry(uint256 anyId, IRegistry subregistry) external {
        uint256 canonicalId = _requireRegistered(anyId);
        _authorize(canonicalId, SUBREGISTRY_PART, ROLE_SET_SUBREGISTRY);
        _entries[canonicalId].subregistry = subregistry;
        emit SubregistryChanged(canonicalId, subregistry);
    }

    /// @notice Drop a registration, taking its whole subtree with it.
    /// @dev Versions are bumped on the way out so that a later re-registration of the same label
    ///      cannot inherit anything the previous holder delegated.
    function unregister(uint256 anyId) external {
        uint256 canonicalId = _requireRegistered(anyId);
        _authorize(canonicalId, ANY_PART, ROLE_UNREGISTER);

        Entry storage e = _entries[canonicalId];
        unchecked {
            ++e.eacVersionId;
            ++e.tokenVersionId;
        }
        e.expiry = 0;
        e.resolver = address(0);
        e.subregistry = IRegistry(address(0));
        e.owner = address(0);

        emit Unregistered(canonicalId, _labels[canonicalId]);
    }

    /// @notice Write one data record on one name.
    /// @dev The narrow grant this whole contract exists to demonstrate. Authorisation is against
    ///      `resource(nodeOf(canonicalId), dataPart(key))` and the three wider levels above it, so a
    ///      holder of the narrow grant can write this key on this name and nothing else.
    function setRecord(uint256 anyId, string calldata key, bytes calldata value) external {
        uint256 canonicalId = _requireRegistered(anyId);
        _authorize(canonicalId, dataPart(key), ROLE_SET_DATA);
        _records[canonicalId][keccak256(bytes(key))] = value;
        emit RecordChanged(canonicalId, key, key, value);
    }

    function getRecord(uint256 anyId, string calldata key) external view returns (bytes memory) {
        uint256 canonicalId = canonicalOf(anyId);
        if (_entries[canonicalId].expiry <= block.timestamp) return "";
        return _records[canonicalId][keccak256(bytes(key))];
    }

    /// @notice Invalidate every role ever granted against this name, in one write.
    /// @dev Bumping `eacVersionId` moves `nodeOf`, and every four-level resource is derived from it,
    ///      so nothing has to be enumerated. `tokenVersionId` moves with it so an observer holding a
    ///      stale token id sees it stop matching.
    function bumpEacVersion(uint256 anyId) external returns (uint256 newTokenId) {
        uint256 canonicalId = _requireRegistered(anyId);
        Entry storage e = _entries[canonicalId];
        if (msg.sender != e.owner && !hasRootRoles(ROLE_REGISTRAR, msg.sender)) {
            revert EACUnauthorizedAccountRoles(ROOT_RESOURCE_ID, ROLE_REGISTRAR, msg.sender);
        }

        uint32 previous = e.eacVersionId;
        // Carry the owner across, and only the owner. Anything else granted under the old version -
        // every delegate, at every level of the ladder - is left behind unreachable.
        uint256 ownerRoles = _roles[resource(nodeOf(canonicalId), ANY_PART)][e.owner];
        unchecked {
            ++e.eacVersionId;
            ++e.tokenVersionId;
        }
        if (ownerRoles != 0) {
            _setRoles(resource(nodeOf(canonicalId), ANY_PART), ownerRoles, e.owner, true);
        }

        newTokenId = canonicalId | e.tokenVersionId;
        emit EacVersionBumped(canonicalId, previous, e.eacVersionId);
        emit TokenResource(newTokenId, resource(nodeOf(canonicalId), ANY_PART));
    }

    // ---------------------------------------------------------------------------------------------
    // Resource and id derivation
    // ---------------------------------------------------------------------------------------------

    /// @notice `keccak256(node, part)`, matching ENSv2's `PermissionedResolverLib.resource`.
    function resource(uint256 node, bytes32 part) public pure returns (uint256) {
        return uint256(keccak256(abi.encode(node, part)));
    }

    /// @notice The name-scoped node id. Moves whenever `eacVersionId` moves.
    function nodeOf(uint256 canonicalId) public view returns (uint256) {
        return uint256(keccak256(abi.encode(canonicalId, _entries[canonicalId].eacVersionId)));
    }

    /// @notice The `part` for a data record key.
    function dataPart(string memory key) public pure returns (bytes32) {
        return keccak256(abi.encode(DATA_PART_DOMAIN, keccak256(bytes(key))));
    }

    function resolverPart() external pure returns (bytes32) {
        return RESOLVER_PART;
    }

    function subregistryPart() external pure returns (bytes32) {
        return SUBREGISTRY_PART;
    }

    /// @notice `labelhash ^ uint32(labelhash)` - the low 32 bits are the token version, not identity.
    function canonicalIdOf(string memory label) public pure returns (uint256) {
        uint256 h = uint256(keccak256(bytes(label)));
        // The truncation is the point: XOR-ing the low word back in clears it.
        // forge-lint: disable-next-line(unsafe-typecast)
        return h ^ uint32(h);
    }

    /// @notice Normalise a labelhash or a token id to the canonical id.
    function canonicalOf(uint256 anyId) public pure returns (uint256) {
        // forge-lint: disable-next-line(unsafe-typecast)
        return anyId ^ uint32(anyId);
    }

    function tokenIdOf(uint256 anyId) external view returns (uint256) {
        uint256 canonicalId = canonicalOf(anyId);
        return canonicalId | _entries[canonicalId].tokenVersionId;
    }

    function getEntry(uint256 anyId) external view returns (Entry memory) {
        return _entries[canonicalOf(anyId)];
    }

    function labelOf(uint256 anyId) external view returns (string memory) {
        return _labels[canonicalOf(anyId)];
    }

    // ---------------------------------------------------------------------------------------------
    // Enhanced Access Control
    // ---------------------------------------------------------------------------------------------

    uint256 private constant ROOT_RESOURCE_ID = 0;

    /// @inheritdoc IEnhancedAccessControl
    function ROOT_RESOURCE() external pure returns (uint256) {
        return ROOT_RESOURCE_ID;
    }

    /// @inheritdoc IEnhancedAccessControl
    function roles(uint256 resource_, address account) external view returns (uint256) {
        return _roles[resource_][account];
    }

    /// @inheritdoc IEnhancedAccessControl
    /// @dev Nybble-packed assignee counts, one nybble per role, which is why a role saturates at 15.
    function roleCount(uint256 resource_) external view returns (uint256) {
        return _roleCounts[resource_];
    }

    /// @inheritdoc IEnhancedAccessControl
    function hasRootRoles(uint256 roleBitmap, address account) public view returns (bool) {
        return (_roles[ROOT_RESOURCE_ID][account] & roleBitmap) == roleBitmap;
    }

    /// @inheritdoc IEnhancedAccessControl
    /// @dev Root is OR'd in, so a root holder passes every resource check.
    function hasRoles(uint256 resource_, uint256 roleBitmap, address account) public view returns (bool) {
        uint256 held = _roles[ROOT_RESOURCE_ID][account] | _roles[resource_][account];
        return (held & roleBitmap) == roleBitmap;
    }

    /// @inheritdoc IEnhancedAccessControl
    function grantRoles(uint256 resource_, uint256 roleBitmap, address account) external returns (bool) {
        if (resource_ == ROOT_RESOURCE_ID) revert EACRootResourceNotAllowed();
        _requireCanAdminister(resource_, roleBitmap, true);
        return _setRoles(resource_, roleBitmap, account, true);
    }

    /// @inheritdoc IEnhancedAccessControl
    function grantRootRoles(uint256 roleBitmap, address account) external returns (bool) {
        _requireCanAdminister(ROOT_RESOURCE_ID, roleBitmap, true);
        return _setRoles(ROOT_RESOURCE_ID, roleBitmap, account, true);
    }

    /// @inheritdoc IEnhancedAccessControl
    function revokeRoles(uint256 resource_, uint256 roleBitmap, address account) external returns (bool) {
        if (resource_ == ROOT_RESOURCE_ID) revert EACRootResourceNotAllowed();
        _requireCanAdminister(resource_, roleBitmap, false);
        return _setRoles(resource_, roleBitmap, account, false);
    }

    /// @inheritdoc IEnhancedAccessControl
    function revokeRootRoles(uint256 roleBitmap, address account) external returns (bool) {
        _requireCanAdminister(ROOT_RESOURCE_ID, roleBitmap, false);
        return _setRoles(ROOT_RESOURCE_ID, roleBitmap, account, false);
    }

    /// @notice Grant a role over exactly one record on exactly one name.
    /// @dev The raw `grantRoles` demands the admin role at the exact resource. This helper accepts an
    ///      admin who holds it at any wider level, which is what makes a name owner able to delegate a
    ///      single key without first granting themselves a role at the narrow resource.
    function grantRecordRoles(uint256 anyId, string calldata key, uint256 roleBitmap, address account)
        external
        returns (bool)
    {
        uint256 canonicalId = _requireRegistered(anyId);
        bytes32 part = dataPart(key);
        _requireCanAdministerScoped(canonicalId, part, roleBitmap, true);
        return _setRoles(resource(nodeOf(canonicalId), part), roleBitmap, account, true);
    }

    /// @notice Take back a grant made by `grantRecordRoles`.
    function revokeRecordRoles(uint256 anyId, string calldata key, uint256 roleBitmap, address account)
        external
        returns (bool)
    {
        uint256 canonicalId = _requireRegistered(anyId);
        bytes32 part = dataPart(key);
        _requireCanAdministerScoped(canonicalId, part, roleBitmap, false);
        return _setRoles(resource(nodeOf(canonicalId), part), roleBitmap, account, false);
    }

    /// @notice The four-level check, exposed so a UI can explain a denial before submitting a tx.
    function hasScopedRoles(uint256 canonicalId, bytes32 part, uint256 roleBitmap, address account)
        public
        view
        returns (bool)
    {
        uint256 node = nodeOf(canonicalId);
        return hasRoles(resource(node, part), roleBitmap, account)
            || hasRoles(resource(node, ANY_PART), roleBitmap, account)
            || hasRoles(resource(ANY_NODE, part), roleBitmap, account)
            || hasRoles(resource(ANY_NODE, ANY_PART), roleBitmap, account);
    }

    function supportsInterface(bytes4 interfaceId) external pure returns (bool) {
        return interfaceId == 0x01ffc9a7 // ERC-165
            || interfaceId == type(IRegistry).interfaceId // ENSv2 IRegistry  0x51f67f40
            || interfaceId == EAC_INTERFACE_ID; // ENSv2 EAC        0x8f452d62
    }

    // ---------------------------------------------------------------------------------------------

    function _authorize(uint256 canonicalId, bytes32 part, uint256 role) private view {
        if (!hasScopedRoles(canonicalId, part, role, msg.sender)) {
            revert EACUnauthorizedAccountRoles(resource(nodeOf(canonicalId), part), role, msg.sender);
        }
    }

    /// @dev A role's admin is the role shifted 128 bits up. An admin role administers itself, so a
    ///      holder can pass their own delegation authority on without root.
    function _adminBitmapFor(uint256 roleBitmap) private pure returns (uint256) {
        return ((roleBitmap & LOW_HALF) << ADMIN_SHIFT) | (roleBitmap & ~LOW_HALF);
    }

    function _requireCanAdminister(uint256 resource_, uint256 roleBitmap, bool granting) private view {
        _validateBitmap(roleBitmap);
        if (hasRoles(resource_, _adminBitmapFor(roleBitmap), msg.sender)) return;
        if (granting) revert EACCannotGrantRoles(resource_, roleBitmap, msg.sender);
        revert EACCannotRevokeRoles(resource_, roleBitmap, msg.sender);
    }

    function _requireCanAdministerScoped(uint256 canonicalId, bytes32 part, uint256 roleBitmap, bool granting)
        private
        view
    {
        _validateBitmap(roleBitmap);
        if (hasScopedRoles(canonicalId, part, _adminBitmapFor(roleBitmap), msg.sender)) return;
        uint256 res = resource(nodeOf(canonicalId), part);
        if (granting) revert EACCannotGrantRoles(res, roleBitmap, msg.sender);
        revert EACCannotRevokeRoles(res, roleBitmap, msg.sender);
    }

    function _validateBitmap(uint256 roleBitmap) private pure {
        if (roleBitmap == 0 || roleBitmap & ~NYBBLE_LOW_BITS != 0) revert EACInvalidRoleBitmap(roleBitmap);
    }

    /// @dev Grants or revokes in one place so the assignee counters can never drift from `_roles`.
    /// @return changed False when the account already held exactly this set, so callers can skip a
    ///         redundant event without re-reading storage.
    function _setRoles(uint256 resource_, uint256 roleBitmap, address account, bool granting)
        private
        returns (bool changed)
    {
        if (account == address(0)) revert EACInvalidAccount();

        uint256 oldBitmap = _roles[resource_][account];
        uint256 newBitmap = granting ? oldBitmap | roleBitmap : oldBitmap & ~roleBitmap;
        if (newBitmap == oldBitmap) return false;

        uint256 delta = granting ? newBitmap & ~oldBitmap : oldBitmap & ~newBitmap;
        // Only the low bit of each nybble is a role, so `delta` doubles as "add one to these counters".
        uint256 counters = delta & NYBBLE_LOW_BITS;
        uint256 packed = _roleCounts[resource_];
        if (granting) {
            // A nybble holding 0xF has all four bits set; detect that without a loop.
            uint256 saturated = packed & (packed >> 1) & (packed >> 2) & (packed >> 3) & NYBBLE_LOW_BITS;
            if (saturated & counters != 0) revert EACMaxAssignees(resource_, roleBitmap);
            _roleCounts[resource_] = packed + counters;
        } else {
            _roleCounts[resource_] = packed - counters;
        }

        _roles[resource_][account] = newBitmap;
        emit EACRolesChanged(resource_, account, oldBitmap, newBitmap);
        return true;
    }

    function _requireRegistered(uint256 anyId) private view returns (uint256 canonicalId) {
        canonicalId = canonicalOf(anyId);
        if (_entries[canonicalId].expiry <= block.timestamp) revert NameNotRegistered(canonicalId);
    }
}
