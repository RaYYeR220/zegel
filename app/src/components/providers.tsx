'use client';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { createConfig, http, WagmiProvider } from 'wagmi';
import { base, mainnet } from 'wagmi/chains';
import { injected } from 'wagmi/connectors';

import { DeskProvider } from './health';

/**
 * A wallet is optional here and the config says so.
 *
 * Only two things in this app need a signer — proving control of the wallet you
 * are issuing about, and anchoring the commitment on Base — and both live behind
 * an explicit connect. Everything a counterparty does works with no wallet at
 * all, which is the property that lets someone open the URL and get a real
 * answer.
 *
 * `injected()` alone: no WalletConnect project id, so there is no credential to
 * forget to set and no third-party relay in the path.
 */
const config = createConfig({
  chains: [base, mainnet],
  connectors: [injected()],
  transports: {
    [base.id]: http(),
    [mainnet.id]: http(),
  },
});

export function Providers({ children }: { children: ReactNode }): ReactNode {
  const [queryClient] = useState(() => new QueryClient());

  return (
    <WagmiProvider config={config}>
      <QueryClientProvider client={queryClient}>
        <DeskProvider>{children}</DeskProvider>
      </QueryClientProvider>
    </WagmiProvider>
  );
}
