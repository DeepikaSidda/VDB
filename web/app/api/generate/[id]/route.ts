import { NextResponse } from 'next/server';
import { getSession, toSnapshot } from '@/lib/backend';

export const dynamic = 'force-dynamic';

/**
 * GET /api/generate/{id}
 *
 * Return the current status snapshot for a generation run: the active stage and
 * stage history (Req 9.2), any large-model notice (Req 9.5), the failing stage
 * + reason on failure (Req 9.2), and — once deployed — the dashboard descriptor
 * and entity list the Admin_Dashboard renders from (Req 7.1).
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
  return NextResponse.json(toSnapshot(session));
}
