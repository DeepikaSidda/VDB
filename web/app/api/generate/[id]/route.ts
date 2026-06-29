import { NextResponse } from 'next/server';
import { getOrReopenSession, toSnapshot } from '@/lib/backend';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * GET /api/generate/{id}
 *
 * Return the current status snapshot for a generation run. Reconstructs the
 * session from the live database when it is not in memory (serverless-safe).
 */
export async function GET(
  _request: Request,
  { params }: { params: { id: string } },
) {
  const session = await getOrReopenSession(params.id);
  if (!session) {
    return NextResponse.json(
      { error: `Unknown generation id "${params.id}".` },
      { status: 404 },
    );
  }
  return NextResponse.json(toSnapshot(session));
}
