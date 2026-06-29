import { NextResponse } from 'next/server';
import { openGeneration, toSnapshot } from '@/lib/backend';

export const dynamic = 'force-dynamic';

/**
 * POST /api/generations/open  { schema }
 *
 * Reopen a previously generated backend by introspecting its live schema back
 * into a model and registering a deployed session. Returns the session snapshot
 * (with its new id) so the client can switch straight to the dashboard.
 */
export async function POST(request: Request) {
  let body: { schema?: unknown };
  try {
    body = (await request.json()) as { schema?: unknown };
  } catch {
    return NextResponse.json({ error: 'Request body must be JSON.' }, { status: 400 });
  }
  if (typeof body.schema !== 'string' || body.schema.trim() === '') {
    return NextResponse.json({ error: 'A "schema" name is required.' }, { status: 400 });
  }

  try {
    const session = await openGeneration(body.schema);
    return NextResponse.json(toSnapshot(session), { status: 200 });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 400 },
    );
  }
}
