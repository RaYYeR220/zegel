import { createRequire } from 'node:module';

import { defineConfig } from 'vitest/config';

// The sibling `@zegel/sdk` sources are imported by relative path and resolve their
// own dependencies from this package's tree, so the bare specifiers are pinned to
// the copies installed here.
const require = createRequire(import.meta.url);

export default defineConfig({
  resolve: {
    alias: {
      '@noble/hashes/sha2': require.resolve('@noble/hashes/sha2'),
      '@noble/hashes/sha3': require.resolve('@noble/hashes/sha3'),
      '@noble/hashes/utils': require.resolve('@noble/hashes/utils'),
    },
  },
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
