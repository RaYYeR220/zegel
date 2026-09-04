import type { ReactNode } from 'react';

import { PageHead } from '~/components/document';
import { Issue } from '~/components/issue';

export default function IssuePage(): ReactNode {
  return (
    <>
      <PageHead
        title="Persoonlijke referentie"
        subtitle="Private financial reference"
        page="05"
        pageName="Gegevens"
      />
      <Issue />
    </>
  );
}
