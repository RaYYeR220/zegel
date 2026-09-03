import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const here = (path: string): string => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  resolve: {
    // `@zegel/sdk` ships no manifest yet, so its sources are aliased in directly.
    // The canonical-digest helper must stay shared — a second copy would silently
    // break every commitment in the system. Its own dependency is aliased with it
    // because the sdk directory has no `node_modules` of its own.
    alias: {
      '@zegel/sdk/canonical': here('../sdk/src/canonical.ts'),
      '@zegel/sdk/types': here('../sdk/src/types.ts'),
      '@noble/hashes/sha2': here('./node_modules/@noble/hashes/esm/sha2.js'),
      '@noble/hashes/utils': here('./node_modules/@noble/hashes/esm/utils.js'),
    },
  },
  test: {
    include: ['test/**/*.test.ts', 'scripts/*.record.ts'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
