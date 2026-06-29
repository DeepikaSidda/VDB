import { NextResponse } from 'next/server';
import { startGeneration, toSnapshot } from '@/lib/backend';
import type { JobInput } from '../../../../dist/src/model/types.js';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * POST /api/generate
 *
 * Start a generation run from any of the three "ways to create a backend":
 *  - { mode: 'prompt', prompt }
 *  - { mode: 'document', document: { name, format?, contentType?, content, encoding? } }
 *  - { mode: 'import', engine: 'postgres'|'mysql', connection: { host, port, database, user, password } }
 *
 * Builds the JobInput, kicks off the run, and returns the generation id + an
 * initial status snapshot. The client polls GET /api/generate/{id}.
 */
export async function POST(request: Request) {
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: 'Request body must be JSON.' }, { status: 400 });
  }

  // Default to prompt mode for backward compatibility (body may just be {prompt}).
  const mode = (body.mode as string) ?? 'prompt';

  let input: JobInput;
  let label: string;

  if (mode === 'prompt') {
    const prompt = body.prompt;
    if (typeof prompt !== 'string' || prompt.trim() === '') {
      return NextResponse.json({ error: 'A non-empty "prompt" is required.' }, { status: 400 });
    }
    input = { kind: 'PROMPT', prompt };
    label = prompt.slice(0, 80);
  } else if (mode === 'document') {
    const doc = body.document as Record<string, unknown> | undefined;
    if (!doc || typeof doc.name !== 'string' || typeof doc.content !== 'string') {
      return NextResponse.json(
        { error: 'A "document" with { name, content } is required.' },
        { status: 400 },
      );
    }
    input = {
      kind: 'DOCUMENT',
      document: {
        name: doc.name,
        format: typeof doc.format === 'string' ? doc.format : undefined,
        contentType: typeof doc.contentType === 'string' ? doc.contentType : undefined,
        content: doc.content,
        encoding: doc.encoding === 'base64' ? 'base64' : 'utf8',
      },
    };
    label = `Document: ${doc.name}`;
  } else if (mode === 'import') {
    const engine = body.engine === 'mysql' ? 'mysql' : 'postgres';
    const conn = body.connection as Record<string, unknown> | undefined;
    if (
      !conn ||
      typeof conn.host !== 'string' ||
      typeof conn.database !== 'string' ||
      typeof conn.user !== 'string' ||
      typeof conn.password !== 'string'
    ) {
      return NextResponse.json(
        { error: 'A "connection" with { host, database, user, password } is required.' },
        { status: 400 },
      );
    }
    const port = typeof conn.port === 'number' ? conn.port : engine === 'mysql' ? 3306 : 5432;
    input = {
      kind: 'IMPORT',
      engine,
      connection: {
        host: conn.host,
        port,
        database: conn.database,
        user: conn.user,
        password: conn.password,
      },
    };
    label = `Import ${engine}: ${conn.database}`;
  } else {
    return NextResponse.json({ error: `Unknown mode "${mode}".` }, { status: 400 });
  }

  const session = await startGeneration(input, label);
  return NextResponse.json(toSnapshot(session), { status: 202 });
}
