/**
 * Postgres data sink — loads the document-derived seed rows into the live
 * Aurora/RDS PostgreSQL schema that the migration just created.
 *
 * The Provisioner deploys the *schema* (CREATE TABLE / foreign keys / indexes)
 * into a per-generation schema `gen_<id>`. This module is the missing half that
 * makes the generated backend a genuinely database-backed one: after that
 * schema is committed, it opens a connection, sets `search_path` to the same
 * schema, and INSERTs the seeded rows with parameterized statements.
 *
 * Rows are inserted in the seed map's order (referenced/group entities first,
 * the main entity last) so foreign-key constraints are satisfied. Each row's
 * present columns are inserted by name; absent columns fall back to their
 * column default / NULL. Inserts are parameterized (never string-interpolated)
 * so values cannot break out of their placeholders.
 *
 * The `pg` module is imported lazily so loading this file never fails when the
 * optional dependency is absent (e.g. a pure in-memory run).
 */

import type { DataModel, DeploymentTarget } from '../model/types.js';
import type { SeedData } from '../modeling/records.js';

/** The subset of a `pg` Client this sink relies on. */
interface PgClientLike {
  connect(): Promise<void>;
  query(sql: string, values?: unknown[]): Promise<{ rowCount?: number | null }>;
  end(): Promise<void>;
}

/** Outcome of a seeding pass: how many rows were inserted per entity. */
export type SeedPersistResult = {
  schema: string;
  inserted: Record<string, number>;
  total: number;
};

/** Double-quote a PostgreSQL identifier, escaping embedded quotes. */
function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/**
 * The union of modeled columns present across the batch's rows, in first-seen
 * order. Rows missing a column contribute NULL for it, so a single multi-row
 * INSERT can carry rows with slightly different key sets.
 */
function orderedColumns(
  rows: readonly Record<string, unknown>[],
  allowed: ReadonlySet<string>,
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      if (allowed.has(key) && !seen.has(key)) {
        seen.add(key);
        out.push(key);
      }
    }
  }
  return out;
}

/**
 * Insert a batch of rows into `entity` as a single multi-row INSERT over the
 * given `columns`. Returns the number of rows inserted. Missing values are sent
 * as NULL so the column's default/nullability applies.
 */
async function insertBatch(
  client: PgClientLike,
  entity: string,
  columns: readonly string[],
  rows: readonly Record<string, unknown>[],
): Promise<number> {
  if (rows.length === 0) {
    return 0;
  }
  const values: unknown[] = [];
  const tuples: string[] = [];
  let p = 0;
  for (const row of rows) {
    const placeholders: string[] = [];
    for (const col of columns) {
      values.push(row[col] ?? null);
      p += 1;
      placeholders.push(`$${p}`);
    }
    tuples.push(`(${placeholders.join(', ')})`);
  }
  const sql =
    `INSERT INTO ${quoteIdent(entity)} (${columns.map(quoteIdent).join(', ')}) ` +
    `VALUES ${tuples.join(', ')}`;
  const res = await client.query(sql, values);
  return res.rowCount ?? rows.length;
}

/**
 * Insert the seeded rows into the deployed schema on the live target.
 *
 * Connects to `target`, sets `search_path` to `schema`, and inserts every seed
 * row for each entity (in seed order). Only columns declared on the entity in
 * `model` are written, so unknown keys never reach the database. Returns the
 * per-entity inserted counts.
 *
 * Throws on a connection failure; individual row failures are collected and
 * re-thrown as a single aggregate error after attempting the rest, so one bad
 * row does not silently drop the remainder.
 */
export async function persistSeedToPostgres(
  target: DeploymentTarget,
  schema: string,
  model: DataModel,
  seed: SeedData,
): Promise<SeedPersistResult> {
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

  // Column names declared on each entity, so only modeled columns are written.
  const columnsByEntity = new Map<string, Set<string>>();
  for (const entity of model.entities) {
    columnsByEntity.set(entity.name, new Set(entity.attributes.map((a) => a.name)));
  }

  const inserted: Record<string, number> = {};
  const errors: string[] = [];

  await client.connect();
  try {
    await client.query(`SET search_path TO ${quoteIdent(schema)}`);

    for (const [entityName, rows] of seed) {
      const allowed = columnsByEntity.get(entityName);
      if (allowed === undefined) {
        continue;
      }
      inserted[entityName] = 0;
      if (rows.length === 0) {
        continue;
      }

      // Insert in batches of multi-row VALUES to minimize network round-trips
      // (a row-at-a-time loop across the internet is pathologically slow for
      // large documents). All rows of one entity share the same column set
      // here because the seed builder emits uniform rows per entity; if a row
      // diverges it is still handled because we key columns per row below.
      const columns = orderedColumns(rows, allowed);
      if (columns.length === 0) {
        continue;
      }
      // Postgres caps parameters per statement at 65535; stay well under it.
      const maxParams = 60000;
      const batchSize = Math.max(1, Math.min(1000, Math.floor(maxParams / columns.length)));

      for (let start = 0; start < rows.length; start += batchSize) {
        const batch = rows.slice(start, start + batchSize);
        try {
          inserted[entityName] += await insertBatch(client, entityName, columns, batch);
        } catch {
          // A batch failed (e.g. one bad row). Fall back to row-by-row for this
          // batch so a single offending row does not drop the rest.
          for (const row of batch) {
            try {
              inserted[entityName] += await insertBatch(client, entityName, columns, [row]);
            } catch (error) {
              errors.push(
                `${entityName}: ${error instanceof Error ? error.message : String(error)}`,
              );
            }
          }
        }
      }
    }
  } finally {
    await client.end().catch(() => undefined);
  }

  if (errors.length > 0) {
    // Surface a bounded summary; the successful inserts above still committed.
    throw new Error(
      `seeded ${Object.values(inserted).reduce((a, b) => a + b, 0)} row(s) but ` +
        `${errors.length} failed: ${errors.slice(0, 5).join('; ')}` +
        (errors.length > 5 ? ' …' : ''),
    );
  }

  const total = Object.values(inserted).reduce((a, b) => a + b, 0);
  return { schema, inserted, total };
}
