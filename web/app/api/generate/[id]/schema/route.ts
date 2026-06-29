import { NextResponse } from 'next/server';
import { getOrReopenSession, buildSchemaView } from '@/lib/backend';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * GET /api/generate/{id}/schema
 *
 * The client-safe schema view (entities, columns, relationships) powering the
 * structure diagram + REST API panel. Reconstructs from the live database when
 * not in memory.
 */
export async function GET(_request: Request, { params }: { params: { id: string } }) {
  const session = await getOrReopenSession(params.id);
  if (!session) {
    return NextResponse.json({ error: `Unknown generation id "${params.id}".` }, { status: 404 });
  }
  if (session.status !== 'deployed' || !session.backend) {
    return NextResponse.json(
      { error: 'Backend is not deployed yet.', stage: session.stage, status: session.status },
      { status: 409 },
    );
  }
  const schema = buildSchemaView(session);
  return NextResponse.json(schema ?? { entities: [], relationships: [] });
}
