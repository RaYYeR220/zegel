import type { Metadata, Viewport } from 'next';
import { Archivo_Narrow, Courier_Prime, Source_Sans_3 } from 'next/font/google';
import type { ReactNode } from 'react';

import { Guilloche, Laminate } from '~/components/document';
import { HealthStrip } from '~/components/health';
import { Providers } from '~/components/providers';
import { Thumbs } from '~/components/thumbs';
import { Wallet } from '~/components/wallet';
import { ZEGEL_NAME } from '~/lib/config';

import './globals.css';

/**
 * Self-hosted at build time, which is the point.
 *
 * A privacy product that pulls its typefaces from a third party on every page
 * load hands that third party a log of everyone who read a reference. These are
 * fetched once during the build and served from our own origin.
 */
const narrow = Archivo_Narrow({
  subsets: ['latin'],
  weight: ['400', '500'],
  variable: '--font-narrow-face',
  display: 'swap',
});

const sans = Source_Sans_3({
  subsets: ['latin'],
  weight: ['400', '600'],
  variable: '--font-sans',
  display: 'swap',
});

const mono = Courier_Prime({
  subsets: ['latin'],
  weight: ['400', '700'],
  variable: '--font-mono-face',
  display: 'swap',
});

export const metadata: Metadata = {
  title: 'Zegel — persoonlijke financiële referentie',
  description:
    'A private financial reference. Prove you are good with money to one person, for a limited time, revocably, under a name — without revealing the wallet.',
};

export const viewport: Viewport = {
  themeColor: '#14293F',
  width: 'device-width',
  initialScale: 1,
};

export default function RootLayout({ children }: { children: ReactNode }): ReactNode {
  return (
    <html lang="nl" className={`${narrow.variable} ${sans.variable} ${mono.variable}`}>
      <body>
        <Providers>
          <div className="deskbar">
            <div className="who">
              ZEGEL <b>— persoonlijke financiële referentie</b>
            </div>
            <div style={{ display: 'flex', gap: 18, alignItems: 'baseline', flexWrap: 'wrap' }}>
              <span>{ZEGEL_NAME}</span>
              <Wallet />
            </div>
          </div>

          <div className="booklet">
            <div className="docpage">
              <Guilloche />
              <div className="pagecontent">{children}</div>
              <Laminate />
            </div>
            <Thumbs />
          </div>

          <HealthStrip />
        </Providers>
      </body>
    </html>
  );
}
