import { handlePatch } from '~/lib/server/patchRoute';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function POST(request: Request): Promise<Response> {
  return handlePatch(request, 'grant');
}
