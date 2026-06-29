import { NextResponse } from 'next/server';
import { getSession, buildSchemaView } from '@/lib/backend';

export const dynamic = 'force-dynamic';

/**
 * GET /api/generate/{id}/schema
 *
 * The client-safe schema view (entities, columns with PK/FK/constraint flags,
 * and foreign-key relationship edges) powering the structure diagram and the
 * REST API panel. Available once the generation is deployed.
 */
export async function GET(_request: Request, { params }: { params: { id: string } }) {
  const session = getSession(params.id);
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
