import { describe, expect, it } from 'vitest';

import { CANONICAL_CHAINS, compareChains, normalizeChain, toQueryChain } from '../src/chains.js';
import { toNetworkId, SOLANA_NETWORK_ID } from '../src/graphql.js';
import { loadBundle } from './helpers.js';

describe('normalizeChain', () => {
  it.each([
    ['evm:1', 'evm:1'],
    ['evm:8453', 'evm:8453'],
    ['EVM:8453', 'evm:8453'],
    ['1', 'evm:1'],
    [1, 'evm:1'],
    [8453, 'evm:8453'],
    ['solana', 'solana'],
    ['solana:solana', 'solana'],
    ['Solana', 'solana'],
    [SOLANA_NETWORK_ID, 'solana'],
    ['Ethereum', 'evm:1'],
    ['Base', 'evm:8453'],
    ['XDAI', 'evm:100'],
    ['Arbitrum One', 'evm:42161'],
  ])('folds %o into %s', (input, expected) => {
    expect(normalizeChain(input)).toBe(expected);
  });

  it.each([null, undefined, '', '   ', 'evm:', 'evm:abc', 'not-a-chain'])(
    'returns null for %o rather than guessing',
    (input) => {
      expect(normalizeChain(input)).toBeNull();
    },
  );

  it('is idempotent', () => {
    for (const chain of ['evm:1', 'solana:solana', 'Base', 8453]) {
      const once = normalizeChain(chain);
      expect(normalizeChain(once)).toBe(once);
    }
  });
});

describe('round trips', () => {
  it('maps canonical chains to query filters and back', () => {
    for (const chain of CANONICAL_CHAINS) {
      expect(normalizeChain(toQueryChain(chain))).toBe(chain);
    }
  });

  it('maps canonical chains to GraphQL network ids and back', () => {
    expect(toNetworkId('evm:1')).toBe(1);
    expect(toNetworkId('evm:8453')).toBe(8453);
    expect(toNetworkId('solana')).toBe(SOLANA_NETWORK_ID);
    expect(toNetworkId('cosmos')).toBeNull();
    for (const chain of CANONICAL_CHAINS) {
      expect(normalizeChain(toNetworkId(chain))).toBe(chain);
    }
  });

  it('orders chains stably', () => {
    const shuffled = ['solana', 'evm:8453', 'evm:1'];
    expect([...shuffled].sort(compareChains)).toEqual(['evm:1', 'evm:8453', 'solana']);
  });
});

describe('against the recorded responses', () => {
  it('normalizes every chain identifier the live API actually returned', () => {
    const spellings = new Set<string>();
    for (const name of ['bundle-evm', 'bundle-solana'] as const) {
      const bundle = loadBundle(name);
      for (const source of bundle.sources) {
        collectChainIds(source.body, spellings);
      }
    }
    expect(spellings.size).toBeGreaterThan(1);
    for (const spelling of spellings) {
      expect(normalizeChain(spelling), `unhandled chain spelling ${spelling}`).not.toBeNull();
    }
  });
});

function collectChainIds(value: unknown, into: Set<string>): void {
  if (Array.isArray(value)) {
    for (const item of value) collectChainIds(item, into);
    return;
  }
  if (value === null || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if ((key === 'chainId' || key === 'blockchain') && typeof child === 'string' && child !== '') {
      into.add(child);
    }
    collectChainIds(child, into);
  }
}
