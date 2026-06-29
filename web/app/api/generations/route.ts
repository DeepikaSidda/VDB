import { NextResponse } from 'next/server';
import { listGenerations } from '@/lib/backend';

export const dynamic = 'force-dynamic';

/**
 * GET /api/generations
 *
 * List every previously generated backend that still exists in the live
 * database (the `gen_*` schemas), with each entity's row count. Powers the
 * "Saved backends" history on the home screen.
 */
export async function GET() {
  try {
    const generations = await listGenerations();
    return NextResponse.json({ generations });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error), generations: [] },
      { status: 200 },
    );
  }
}
