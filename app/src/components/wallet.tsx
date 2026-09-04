'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { useAccount, useConnect, useDisconnect } from 'wagmi';

import { shortHex } from '~/lib/format';

/**
 * The connect control in the desk bar.
 *
 * Rendered only after mount: the wallet state lives in the browser, and a server
 * render that guesses at it produces a hydration mismatch on the one control that
 * has to be trustworthy.
 */
export function Wallet(): ReactNode {
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    setMounted(true);
  }, []);

  const { address, isConnected } = useAccount();
  const { connect, connectors, isPending } = useConnect();
  const { disconnect } = useDisconnect();

  if (!mounted) return <span style={{ opacity: 0.6 }}>wallet —</span>;

  const injectedConnector = connectors[0];

  if (isConnected && address !== undefined) {
    return (
      <span style={{ display: 'inline-flex', gap: 10, alignItems: 'baseline' }}>
        <span title={address}>{shortHex(address, 8, 4)}</span>
        <button
          type="button"
          onClick={() => {
            disconnect();
          }}
          style={linkButton}
        >
          ontkoppelen
        </button>
      </span>
    );
  }

  if (injectedConnector === undefined) {
    return <span style={{ opacity: 0.6 }}>no browser wallet detected</span>;
  }

  return (
    <button
      type="button"
      onClick={() => {
        connect({ connector: injectedConnector });
      }}
      disabled={isPending}
      style={linkButton}
    >
      {isPending ? 'verbinden…' : 'portefeuille verbinden / connect'}
    </button>
  );
}

const linkButton: React.CSSProperties = {
  background: 'none',
  border: 0,
  borderBottom: '1px solid rgba(159,180,203,.4)',
  color: '#9fb4cb',
  padding: 0,
  cursor: 'pointer',
  font: 'inherit',
  letterSpacing: 'inherit',
  textTransform: 'inherit',
};
