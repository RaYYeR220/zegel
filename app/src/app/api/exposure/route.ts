import { ndjsonStream } from '~/lib/ndjson';
import { analyseExposure, collect, meter, mobula } from '~/lib/server/evidence';
import { resolveSubject, SubjectError } from '~/lib/server/subject';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
/** Roughly twenty upstream calls with retries. Sized for the smallest plan a judge might deploy on. */
export const maxDuration = 60;

/**
 * The dossier the surveillance industry already has.
 *
 * Streamed rather than awaited because the interesting part of a thirty-second
 * collection is *which* endpoint answered and what it cost — a spinner over that
 * is a lie of omission. Nothing about this route needs a wallet or a key.
 */
export async function POST(request: Request): Promise<Response> {
  const { input } = (await request.json()) as { input?: unknown };
  if (typeof input !== 'string' || input.trim() === '') {
    return Response.json({ error: 'give an address or an ENS name' }, { status: 400 });
  }

  return ndjsonStream(async (sink) => {
    let subject;
    try {
      subject = await resolveSubject(input);
    } catch (cause) {
      sink.send({
        type: 'error',
        message: cause instanceof Error ? cause.message : String(cause),
        hint: cause instanceof SubjectError ? cause.hint : null,
      });
      return;
    }

    sink.send({ type: 'subject', subject });

    const client = mobula();
    sink.send({
      type: 'source',
      host: client.baseUrl,
      keyed: client.hasApiKey,
    });

    const stopMeter = client.rateLimit.subscribe((snapshot) => {
      sink.send({ type: 'credits', snapshot, spent: client.rateLimit.spent });
    });

    try {
      const bundle = await collect(client, subject.address, {
        onProgress: (event) => {
          sink.send({ type: 'progress', ...event });
        },
      });

      sink.send({
        type: 'report',
        subject,
        report: analyseExposure(bundle),
        credits: meter(client),
        collectedAt: new Date().toISOString(),
      });
    } finally {
      stopMeter();
    }
  });
}
