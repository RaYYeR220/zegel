import { getAddress, isAddress, type Address, type Hex, type PublicClient } from 'viem';

/** ENS registry, Ethereum mainnet. */
export const ENS_REGISTRY = '0x00000000000C2E074eC69A0dFb2997BA6C7d2e1e' as const;

const REGISTRY_ABI = [
  {
    type: 'function',
    name: 'owner',
    stateMutability: 'view',
    inputs: [{ name: 'node', type: 'bytes32' }],
    outputs: [{ type: 'address' }],
  },
] as const;

const NAME_WRAPPER_ABI = [
  {
    type: 'function',
    name: 'ownerOf',
    stateMutability: 'view',
    inputs: [{ name: 'id', type: 'uint256' }],
    outputs: [{ type: 'address' }],
  },
] as const;

export interface OwnerProbe {
  readonly ok: boolean;
  readonly detail: string;
  readonly latencyMs: number;
}

/**
 * Answers "who is allowed to publish under this node".
 *
 * This is the only authentication in the gateway, and it is deliberately not an API
 * key. The resolver's gateway URL is public on chain — `cast call <resolver>
 * "gatewayUrls()(string[])"` prints it — so a key embedded in that string is a
 * credential published to the world. Ownership of the name is the only authority
 * that is already public, already on chain, and already the right one.
 */
export interface OwnerLookup {
  readonly kind: string;
  readonly description: string;
  ownerOf(node: Hex): Promise<Address | null>;
  probe(): Promise<OwnerProbe>;
}

/**
 * A configured node → owner map.
 *
 * For local runs and tests, where there is no chain to ask. It is not a weaker
 * check — the operator states the answer instead of reading it — but it is a
 * statement by the operator, and `/health` says so rather than implying a chain
 * lookup happened.
 */
export function staticOwners(entries: Iterable<readonly [Hex, Address]>): OwnerLookup {
  const owners = new Map<string, Address>();
  for (const [node, owner] of entries) owners.set(node.toLowerCase(), getAddress(owner));

  return {
    kind: 'static',
    description: `operator-configured owner map, ${owners.size} name(s); no chain lookup`,
    async ownerOf(node) {
      return owners.get(node.toLowerCase()) ?? null;
    },
    async probe() {
      return {
        // An empty map is not "healthy and idle" — it is a gateway that will refuse
        // every publish, which the operator needs told.
        ok: owners.size > 0,
        detail:
          owners.size > 0
            ? `${owners.size} name(s) configured; ownership is asserted by the operator, not read from chain`
            : 'no owner source configured: set ZEGEL_RPC_URL to read the ENS registry, or ZEGEL_NAME_OWNERS for a local run. Publishing is refused until then.',
        latencyMs: 0,
      };
    },
  };
}

/**
 * The ENS registry, read live.
 *
 * A wrapped `.eth` name has the NameWrapper as its registry owner, so the real
 * owner is a second hop. The NameWrapper address is configuration rather than a
 * constant here: it is not one of the addresses this project verified on chain, and
 * a hardcoded wrong address would fail as "you do not own this name", which is the
 * worst possible way for a misconfiguration to present.
 */
export function chainOwners(options: {
  client: PublicClient;
  registry?: Address;
  nameWrapper?: Address | null;
}): OwnerLookup {
  const registry = options.registry ?? ENS_REGISTRY;
  const nameWrapper = options.nameWrapper ?? null;

  return {
    kind: 'chain',
    description: nameWrapper
      ? `ENS registry ${registry} with NameWrapper ${nameWrapper}`
      : `ENS registry ${registry}; no NameWrapper configured, so wrapped names resolve to the wrapper`,

    async ownerOf(node) {
      const registryOwner = await options.client.readContract({
        address: registry,
        abi: REGISTRY_ABI,
        functionName: 'owner',
        args: [node],
      });
      if (!isAddress(registryOwner) || registryOwner === '0x0000000000000000000000000000000000000000') {
        return null;
      }
      if (nameWrapper && getAddress(registryOwner) === getAddress(nameWrapper)) {
        const wrapped = await options.client.readContract({
          address: nameWrapper,
          abi: NAME_WRAPPER_ABI,
          functionName: 'ownerOf',
          args: [BigInt(node)],
        });
        return wrapped === '0x0000000000000000000000000000000000000000' ? null : getAddress(wrapped);
      }
      return getAddress(registryOwner);
    },

    async probe() {
      const started = Date.now();
      try {
        const chainId = await options.client.getChainId();
        const code = await options.client.getCode({ address: registry });
        const latencyMs = Date.now() - started;
        if (!code || code === '0x') {
          return {
            ok: false,
            detail: `no contract code at the configured ENS registry ${registry} on chain ${chainId}`,
            latencyMs,
          };
        }
        return { ok: true, detail: `${this.description} on chain ${chainId}`, latencyMs };
      } catch (error) {
        return {
          ok: false,
          detail: `ENS registry read failed: ${error instanceof Error ? error.message : String(error)}`,
          latencyMs: Date.now() - started,
        };
      }
    },
  };
}
