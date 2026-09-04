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
    return config;
  },
};

export default nextConfig;
