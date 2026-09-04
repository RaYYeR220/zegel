'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';

/**
 * The thumb index down the fore-edge.
 *
 * Real links rather than tab state: each page of this booklet has a URL, so a
 * judge can be handed the one that matters and land on it.
 */
const PAGES = [
  { href: '/', number: '03', nl: 'Waarnemingen', en: 'Observations' },
  { href: '/issue', number: '05', nl: 'Gegevens', en: 'Data page' },
  { href: '/access', number: '07', nl: 'Visa', en: 'Endorsements' },
  { href: '/verify', number: '09', nl: 'Controle', en: 'Inspection' },
] as const;

export function Thumbs(): ReactNode {
  const pathname = usePathname();

  return (
    <nav className="thumbs" aria-label="Bladzijden van dit boekje">
      {PAGES.map((page) => (
        <Link
          key={page.href}
          href={page.href}
          className="thumb"
          aria-current={pathname === page.href ? 'page' : undefined}
        >
          <span className="tn">{page.number}</span>
          <span className="tl">
            {page.nl}
            <br />
            {page.en}
          </span>
        </Link>
      ))}
    </nav>
  );
}
