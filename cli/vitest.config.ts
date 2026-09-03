import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const here = (path: string): string => fileURLToPath(new URL(path, import.meta.url));

/**
 * The sibling packages are reached by path rather than by workspace dependency,
 * mirroring `tsconfig.json`. The two `@zegel/sdk` subpaths come first: Vite
 * matches a string alias by prefix, so a bare `@zegel/sdk` entry above them would
 * swallow both and every commitment in the tests would be computed by a different
 * copy of the digest helper.
 */
export default defineConfig({
  resolve: {
    alias: [
      { find: '@zegel/sdk/canonical', replacement: here('../packages/sdk/src/canonical.ts') },
      { find: '@zegel/sdk/types', replacement: here('../packages/sdk/src/types.ts') },
      { find: '@zegel/sdk', replacement: here('../packages/sdk/src/index.ts') },
      { find: '@zegel/evidence', replacement: here('../packages/evidence/src/index.ts') },
      { find: '@zegel/seal', replacement: here('../packages/seal/src/index.ts') },
    ],
  },
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
