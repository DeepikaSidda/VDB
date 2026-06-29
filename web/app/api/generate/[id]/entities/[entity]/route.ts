import { NextResponse } from 'next/server';
import { getOrReopenSession, type GenerationSession } from '@/lib/backend';
import { listRecords, createRecord, type ListParams } from '@/lib/crud';
import type { FilterOperator } from '../../../../../../../dist/src/dashboard/query.js';
import type { EntityRecord } from '../../../../../../../dist/src/api/crudRuntime.js';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const FILTER_OPS: ReadonlySet<string> = new Set([
  'eq',
  'neq',
  'contains',
  'gt',
  'gte',
  'lt',
  'lte',
]);

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
 * GET /api/generate/{id}/entities/{entity}
 *
 * List / search / filter an entity's records (Req 7.2, 7.6–7.8). Query params:
 *   page, size              — pagination
 *   search                  — substring search over searchable attributes
 *   filterAttr, filterOp, filterVal — single attribute filter
 */
export async function GET(
  request: Request,
  { params }: { params: { id: string; entity: string } },
) {
  const guard = await requireDeployed(params.id);
  if (!guard.ok) return guard.response;

  const url = new URL(request.url);
  const filterOpRaw = url.searchParams.get('filterOp') ?? undefined;
  const listParams: ListParams = {
    page: numberParam(url.searchParams.get('page')),
    size: numberParam(url.searchParams.get('size')),
    search: url.searchParams.get('search') ?? undefined,
    filterAttribute: url.searchParams.get('filterAttr') ?? undefined,
    filterOperator:
      filterOpRaw && FILTER_OPS.has(filterOpRaw)
        ? (filterOpRaw as FilterOperator)
        : undefined,
    filterValue: url.searchParams.get('filterVal') ?? undefined,
  };

  const result = listRecords(guard.session, params.entity, listParams);
  const resolved = await result;
  if ('error' in resolved) {
    return NextResponse.json({ error: resolved.error }, { status: 400 });
  }
  return NextResponse.json(resolved);
}

/**
 * POST /api/generate/{id}/entities/{entity}
 *
 * Create a record. On success returns the created record with its assigned
 * primary key (201) so the dashboard reflects the new state (Req 7.4). On a
 * constraint violation returns 400 with the violations, persisting nothing, so
 * the dashboard leaves records unchanged and shows the error (Req 7.5).
 */
export async function POST(
  request: Request,
  { params }: { params: { id: string; entity: string } },
) {
  const guard = await requireDeployed(params.id);
  if (!guard.ok) return guard.response;

  let payload: EntityRecord;
  try {
    payload = (await request.json()) as EntityRecord;
  } catch {
    return NextResponse.json({ error: 'Request body must be JSON.' }, { status: 400 });
  }

  const outcome = await createRecord(guard.session, params.entity, payload);
  if (outcome.ok) {
    return NextResponse.json(outcome.value, { status: 201 });
  }
  return NextResponse.json({ error: outcome.error }, { status: outcome.status });
}

function numberParam(raw: string | null): number | undefined {
  if (raw === null || raw.trim() === '') return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}
