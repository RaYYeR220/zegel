import { createRequire } from 'node:module';

import { defineConfig } from 'vitest/config';

// `@zegel/sdk` is imported by relative path and resolves its own dependencies from
// its own tree, which does not exist. Pin the bare specifiers to the copies here.
const require = createRequire(import.meta.url);

export default defineConfig({
  resolve: {
    alias: {
      '@noble/hashes/sha2': require.resolve('@noble/hashes/sha2'),
      '@noble/hashes/utils': require.resolve('@noble/hashes/utils'),
    },
  },
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    // The contract cross-check boots anvil and deploys the real resolver bytecode.
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
