import type { ReactNode } from 'react';

import { Exposure } from '~/components/exposure';
import { PageHead } from '~/components/document';

export default function ExposurePage(): ReactNode {
  return (
    <>
      <PageHead
        title="Waarnemingen"
        subtitle="Observations by third parties"
        page="03"
        pageName="Waarnemingen"
      />
      <Exposure />
    </>
  );
}
