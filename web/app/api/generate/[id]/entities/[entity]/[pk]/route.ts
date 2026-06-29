import { NextResponse } from 'next/server';
import { getOrReopenSession, type GenerationSession } from '@/lib/backend';
import { updateRecord, deleteRecord } from '@/lib/crud';
import type { EntityRecord } from '../../../../../../../../dist/src/api/crudRuntime.js';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

type Guard =
  | { ok: false; response: NextResponse }
  | { ok: true; session: GenerationSession };

async function requireDeployed(id: string): Promise<Guard> {
  const session = await getOrReopenSession(id);
  if (!session) {
    return {
      ok: false,
      response: NextResponse.json({ error: `Unknown generation id "${id}".` }, { status: 404 }),
    };
  }
  if (session.status !== 'deployed' || !session.backend) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: 'Backend is not deployed yet.', stage: session.stage, status: session.status },
        { status: 409 },
      ),
    };
  }
  return { ok: true, session };
}

/**
 * PUT /api/generate/{id}/entities/{entity}/{pk}
 *
 * Update a record addressed by a single-column primary key value. On success
 * returns the updated record (Req 7.4); on a constraint violation returns 400
 * and persists nothing; on an absent key returns 404 (Req 7.5). Composite
 * primary keys are not addressable through this scalar-pk route in the slice.
 */
export async function PUT(
  request: Request,
  { params }: { params: { id: string; entity: string; pk: string } },
) {
  const guard = await requireDeployed(params.id);
  if (!guard.ok) return guard.response;

  let payload: EntityRecord;
  try {
    payload = (await request.json()) as EntityRecord;
  } catch {
    return NextResponse.json({ error: 'Request body must be JSON.' }, { status: 400 });
  }

  const outcome = await updateRecord(
    guard.session,
    params.entity,
    decodeURIComponent(params.pk),
    payload,
  );
  if (outcome.ok) {
    return NextResponse.json(outcome.value);
  }
  return NextResponse.json({ error: outcome.error }, { status: outcome.status });
}

/**
 * DELETE /api/generate/{id}/entities/{entity}/{pk}
 *
 * Delete a record by primary key. Returns a confirmation on success (Req 7.4),
 * or 404 when the key does not exist, leaving stored data unchanged (Req 7.5).
 */
export async function DELETE(
  _request: Request,
  { params }: { params: { id: string; entity: string; pk: string } },
) {
  const guard = await requireDeployed(params.id);
  if (!guard.ok) return guard.response;

  const outcome = await deleteRecord(
    guard.session,
    params.entity,
    decodeURIComponent(params.pk),
  );
  if (outcome.ok) {
    return NextResponse.json(outcome.value);
  }
  return NextResponse.json({ error: outcome.error }, { status: outcome.status });
}
