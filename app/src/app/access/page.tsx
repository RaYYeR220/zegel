import type { ReactNode } from 'react';

import { Access } from '~/components/access';
import { PageHead } from '~/components/document';

export default function AccessPage(): ReactNode {
  return (
    <>
      <PageHead
        title="Visa en aantekeningen"
        subtitle="Visas and endorsements"
        page="07"
        pageName="Visa"
      />
      <Access />
    </>
  );
}
