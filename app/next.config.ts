import path from 'node:path';

import type { NextConfig } from 'next';

/**
 * The sibling packages ship TypeScript source and no build artefact — the same
 * arrangement `cli/` uses. `externalDir` lets the compiler follow the tsconfig
 * path aliases out of this directory, and the extension alias is what makes
 * their internal `./client.js` specifiers land on `client.ts`.
 */
const nextConfig: NextConfig = {
  reactStrictMode: true,
  experimental: {
    externalDir: true,
  },
  // The evidence engine keeps every upstream body verbatim; a tier-2 bundle is
  // routinely a few megabytes on its way to the sealing layer.
  serverExternalPackages: [],
  webpack(config) {
    config.resolve ??= {};
    config.resolve.extensionAlias = {
      ...(config.resolve.extensionAlias ?? {}),
      '.js': ['.ts', '.tsx', '.js'],
    };
    // Sources compiled from outside this directory resolve bare imports relative to
    // their own location, which on a deploy that installs only this package means
    // they resolve to nothing. Point the last resort back here.
    config.resolve.modules = [
      ...(config.resolve.modules ?? ['node_modules']),
      path.resolve(process.cwd(), 'node_modules'),
    ];
    return config;
  },
};

export default nextConfig;
