import { resolveSubject, SubjectError } from '~/lib/server/subject';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<Response> {
  const { input } = (await request.json()) as { input?: unknown };
  if (typeof input !== 'string' || input.trim() === '') {
    return Response.json({ error: 'give an address or an ENS name' }, { status: 400 });
  }

  try {
    return Response.json(await resolveSubject(input));
  } catch (cause) {
    if (cause instanceof SubjectError) {
      return Response.json({ error: cause.message, hint: cause.hint }, { status: 422 });
    }
    throw cause;
  }
}
