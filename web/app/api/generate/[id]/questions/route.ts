import { NextResponse } from 'next/server';
import { getSession, questionsFor } from '@/lib/backend';

export const dynamic = 'force-dynamic';

/**
 * GET /api/generate/{id}/questions
 *
 * Return the clarifying questions derived from the run's model (Req 8.1/8.2),
 * each grounded in an entity/attribute/relationship and offering selectable
 * options. Interactive refinement is optional/skippable in this slice (Req 8.6):
 * the pipeline already runs refinement non-interactively, so these questions are
 * surfaced for display and can be skipped from the UI.
 */
export async function GET(
  _request: Request,
  { params }: { params: { id: string } },
) {
  const session = getSession(params.id);
  if (!session) {
    return NextResponse.json(
      { error: `Unknown generation id "${params.id}".` },
      { status: 404 },
    );
  }
  return NextResponse.json({ questions: questionsFor(session) });
}
