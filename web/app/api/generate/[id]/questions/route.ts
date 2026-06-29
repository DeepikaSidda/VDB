import { NextResponse } from 'next/server';
import { getOrReopenSession, questionsFor } from '@/lib/backend';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * GET /api/generate/{id}/questions
 *
 * Return the clarifying questions derived from the run's model (Req 8.1/8.2).
 * Reconstructs the session from the live database when not in memory.
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
  return NextResponse.json({ questions: questionsFor(session) });
}
