import { controlProofMessage, randomReferenceId } from '@zegel/evidence';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * The reference id and the exact string the subject wallet has to sign.
 *
 * Nothing is remembered between this call and the issue that follows: the server
 * recomputes the message from the id the browser sends back and checks the
 * signature against it. A stateless challenge is fine here because the id is not
 * a secret — it is the public name of the reference, and it belongs to whoever
 * anchors it first.
 */
export async function POST(): Promise<Response> {
  const referenceId = randomReferenceId();
  return Response.json(
    {
      referenceId,
      message: controlProofMessage(referenceId),
    },
    { headers: { 'cache-control': 'no-store' } },
  );
}
