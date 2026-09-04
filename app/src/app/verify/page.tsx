import type { ReactNode } from 'react';

import { PageHead } from '~/components/document';
import { Verify } from '~/components/verify';

export default function VerifyPage(): ReactNode {
  return (
    <>
      <PageHead title="Grenscontrole" subtitle="Inspection" page="09" pageName="Controle" />
      <Verify />
    </>
  );
}
