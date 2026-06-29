/**
 * Post-deploy index optimizer for live Aurora/RDS PostgreSQL deploys.
 *
 * The migration itself already creates a btree index per foreign-key column
 * (Req 3.5). This adds, AFTER a successful deploy, two more classes of index so
 * the generated dashboard stays fast on large tables:
 *
 *  - **Trigram GIN indexes** on TEXT/VARCHAR columns — these accelerate the
 *    dashboard's case-insensitive substring search (`col ILIKE '%term%'`),
 *    which a plain btree index cannot help. Requires the `pg_trgm` extension
 *    (a trusted, user-creatable contrib extension on RDS PostgreSQL 13+).
 *  - **Btree indexes** on the remaining scalar columns (numbers, dates,
 *    booleans) — these accelerate equality / range filters and sorting.
 *
 * It runs as a separate best-effort pass (NOT part of the verified migration),
 * so it can never break the round-trip deploy gate, and any individual failure
 * (e.g. the extension being unavailable) is swallowed — the deployed backend
 * still works, just without that particular index. Every statement uses
 * `IF NOT EXISTS` so re-running is safe.
 */

import type { DataModel, DataType, DeploymentTarget, Entity } from '../model/types.js';

interface PgClientLike {
  connect(): Promise<void>;
  query(sql: string, values?: unknown[]): Promise<unknown>;
  end(): Promise<void>;
}

/** Column types that get a trigram (substring-search) index. */
const TEXTUAL: ReadonlySet<DataType> = new Set<DataType>(['TEXT', 'VARCHAR']);
/** Column types that get a plain btree (filter/sort) index. */
const SCALAR: ReadonlySet<DataType> = new Set<DataType>([
  'INTEGER', 'BIGINT', 'NUMERIC', 'DATE', 'TIMESTAMP', 'BOOLEAN',
]);

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/** A deterministic, length-safe (<=63 byte) index name unique within a schema. */
function indexName(entity: Entity, column: string, kind: string): string {
  const raw = `ix_${entity.name}_${column}_${kind}`.replace(/[^a-zA-Z0-9_]/g, '_');
  if (raw.length <= 63) {
    return raw;
  }
  // Truncate but keep a short hash so distinct long names don't collide.
  let hash = 0;
  for (let i = 0; i < raw.length; i++) {
    hash = (hash * 31 + raw.charCodeAt(i)) >>> 0;
  }
  return `${raw.slice(0, 52)}_${hash.toString(36)}`;
}

/** The summary of an index-optimization pass. */
export type IndexResult = { schema: string; created: number; skipped: number };

/**
 * Create search/filter indexes for every entity in `model` within the deployed
 * `schema` on the live `target`. Best-effort throughout; returns how many
 * indexes were created vs skipped (already-present or failed).
 */
export async function createSearchIndexes(
  target: DeploymentTarget,
  schema: string,
  model: DataModel,
): Promise<IndexResult> {
  const pg = (await import('pg')) as unknown as {
    Client: new (config: Record<string, unknown>) => PgClientLike;
  };
  const client = new pg.Client({
    host: target.connection.host,
    port: target.connection.port,
    database: target.connection.database,
    user: target.connection.user,
    password: target.connection.password,
    connectionTimeoutMillis: 30_000,
    statement_timeout: 300_000,
    ssl: { rejectUnauthorized: false },
  });

  let created = 0;
  let skipped = 0;
  await client.connect();
  try {
    await client.query(`SET search_path TO ${quoteIdent(schema)}`);

    // Enable trigram search; if unavailable, text columns just won't get a
    // trigram index (we fall back to a btree for them).
    let trigram = false;
    try {
      await client.query('CREATE EXTENSION IF NOT EXISTS pg_trgm');
      trigram = true;
    } catch {
      trigram = false;
    }

    for (const entity of model.entities) {
      const pk = new Set(entity.primaryKey);
      for (const attr of entity.attributes) {
        if (pk.has(attr.name)) {
          continue; // PK already indexed by its constraint.
        }
        const isText = TEXTUAL.has(attr.dataType);
        const isScalar = SCALAR.has(attr.dataType);
        if (!isText && !isScalar) {
          continue; // e.g. JSON/UUID payloads — skip.
        }

        const useTrigram = isText && trigram;
        const name = indexName(entity, attr.name, useTrigram ? 'trgm' : 'btree');
        const table = `${quoteIdent(schema)}.${quoteIdent(entity.name)}`;
        const sql = useTrigram
          ? `CREATE INDEX IF NOT EXISTS ${quoteIdent(name)} ON ${table} ` +
            `USING gin (${quoteIdent(attr.name)} gin_trgm_ops)`
          : `CREATE INDEX IF NOT EXISTS ${quoteIdent(name)} ON ${table} ` +
            `(${quoteIdent(attr.name)})`;
        try {
          await client.query(sql);
          created += 1;
        } catch {
          skipped += 1;
        }
      }
    }
  } finally {
    await client.end().catch(() => undefined);
  }
  return { schema, created, skipped };
}
