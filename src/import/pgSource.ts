/**
 * Real node-postgres ('pg') backed {@link SourceDbDriver}.
 *
 * The production adapter the Import_Analyzer uses to introspect a live external
 * PostgreSQL (or PostgreSQL-compatible) database for import (Requirement 11).
 * It implements the same {@link SourceDbDriver} / {@link SourceIntrospector}
 * port as the in-memory fake, so the analyzer's mapping + suggestion logic is
 * unchanged — only the schema source differs.
 *
 * Connection failure classification (Req 11.5): an authentication error
 * (SQLSTATE 28xxx) is raised as a {@link SourceAuthenticationError}; anything
 * else (host unreachable, deadline elapsed) is a
 * {@link SourceConnectionTimeoutError}. The Import_Analyzer maps these to the
 * `AUTHENTICATION_FAILURE` / `CONNECTION_TIMEOUT` error kinds.
 *
 * Introspection reads the standard `information_schema` views plus `pg_indexes`
 * to assemble a {@link SourceSchema} of tables, columns, primary keys, foreign
 * keys, and indexes.
 *
 * The `pg` module is imported lazily so loading this file never fails when the
 * optional dependency is absent.
 */

import type { DbCredentials } from '../model/types.js';
import {
  type SourceColumn,
  type SourceDbDriver,
  type SourceForeignKey,
  type SourceIndex,
  type SourceIntrospector,
  type SourceSchema,
  type SourceTable,
  SourceAuthenticationError,
  SourceConnectionTimeoutError,
} from './sourceDriver.js';

/** The subset of a `pg` Client the source adapter relies on. */
interface PgClientLike {
  connect(): Promise<void>;
  query<R = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: R[] }>;
  end(): Promise<void>;
}

const AUTH_SQLSTATES = new Set(['28000', '28P01']);

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function classifyConnectError(
  error: unknown,
): SourceAuthenticationError | SourceConnectionTimeoutError {
  const code = (error as { code?: unknown })?.code;
  if (typeof code === 'string' && AUTH_SQLSTATES.has(code)) {
    return new SourceAuthenticationError(
      `authentication failed: ${messageOf(error)}`,
    );
  }
  return new SourceConnectionTimeoutError(
    `could not reach the source database: ${messageOf(error)}`,
  );
}

// ---------------------------------------------------------------------------
// Introspection queries
// ---------------------------------------------------------------------------

const COLUMNS_SQL = `
  SELECT table_name, column_name, data_type, is_nullable
  FROM information_schema.columns
  WHERE table_schema = $1
  ORDER BY table_name, ordinal_position;
`;

const PRIMARY_KEYS_SQL = `
  SELECT tc.table_name, kcu.column_name
  FROM information_schema.table_constraints tc
  JOIN information_schema.key_column_usage kcu
    ON tc.constraint_name = kcu.constraint_name
   AND tc.table_schema = kcu.table_schema
  WHERE tc.constraint_type = 'PRIMARY KEY' AND tc.table_schema = $1
  ORDER BY tc.table_name, kcu.ordinal_position;
`;

const FOREIGN_KEYS_SQL = `
  SELECT tc.table_name,
         kcu.column_name,
         ccu.table_name  AS references_table,
         ccu.column_name AS references_column
  FROM information_schema.table_constraints tc
  JOIN information_schema.key_column_usage kcu
    ON tc.constraint_name = kcu.constraint_name
   AND tc.table_schema = kcu.table_schema
  JOIN information_schema.constraint_column_usage ccu
    ON ccu.constraint_name = tc.constraint_name
   AND ccu.table_schema = tc.table_schema
  WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema = $1;
`;

const UNIQUE_COLUMNS_SQL = `
  SELECT tc.table_name, kcu.column_name
  FROM information_schema.table_constraints tc
  JOIN information_schema.key_column_usage kcu
    ON tc.constraint_name = kcu.constraint_name
   AND tc.table_schema = kcu.table_schema
  WHERE tc.constraint_type = 'UNIQUE' AND tc.table_schema = $1;
`;

const INDEXES_SQL = `
  SELECT tablename AS table_name, indexname AS index_name, indexdef
  FROM pg_indexes
  WHERE schemaname = $1;
`;

/**
 * Assemble a {@link SourceSchema} from the raw introspection rows. Pure so it
 * can be unit-tested without a database.
 */
export function buildSourceSchema(rows: {
  columns: { table_name: string; column_name: string; data_type: string; is_nullable: string }[];
  primaryKeys: { table_name: string; column_name: string }[];
  foreignKeys: {
    table_name: string;
    column_name: string;
    references_table: string;
    references_column: string;
  }[];
  uniques: { table_name: string; column_name: string }[];
  indexes: { table_name: string; index_name: string; indexdef: string }[];
}): SourceSchema {
  const tables = new Map<string, SourceTable>();

  const tableFor = (name: string): SourceTable => {
    let t = tables.get(name);
    if (t === undefined) {
      t = { name, columns: [], primaryKey: [], foreignKeys: [], indexes: [] };
      tables.set(name, t);
    }
    return t;
  };

  const uniqueCols = new Set(
    rows.uniques.map((u) => `${u.table_name}\u0000${u.column_name}`),
  );

  for (const c of rows.columns) {
    const column: SourceColumn = {
      name: c.column_name,
      sourceType: c.data_type,
      nullable: c.is_nullable === 'YES',
      unique: uniqueCols.has(`${c.table_name}\u0000${c.column_name}`),
    };
    tableFor(c.table_name).columns.push(column);
  }

  for (const pk of rows.primaryKeys) {
    tableFor(pk.table_name).primaryKey.push(pk.column_name);
  }

  for (const fk of rows.foreignKeys) {
    const ref: SourceForeignKey = {
      column: fk.column_name,
      referencesTable: fk.references_table,
      referencesColumn: fk.references_column,
    };
    tableFor(fk.table_name).foreignKeys.push(ref);
  }

  const indexesByTable = new Map<string, SourceIndex[]>();
  for (const idx of rows.indexes) {
    const list = indexesByTable.get(idx.table_name) ?? [];
    list.push({
      name: idx.index_name,
      columns: parseIndexColumns(idx.indexdef),
      unique: /\bCREATE\s+UNIQUE\s+INDEX\b/i.test(idx.indexdef),
    });
    indexesByTable.set(idx.table_name, list);
  }
  for (const [name, list] of indexesByTable) {
    tableFor(name).indexes.push(...list);
  }

  return { tables: [...tables.values()] };
}

/** Extract the column list from a `CREATE INDEX ... ON t (a, b)` definition. */
function parseIndexColumns(indexdef: string): string[] {
  const match = indexdef.match(/\(([^)]*)\)/);
  if (match === null) {
    return [];
  }
  return match[1]
    .split(',')
    .map((c) => c.trim().replace(/"/g, ''))
    .filter((c) => c.length > 0);
}

class PgIntrospector implements SourceIntrospector {
  constructor(
    private readonly client: PgClientLike,
    private readonly schema: string,
  ) {}

  async introspect(): Promise<SourceSchema> {
    const [columns, primaryKeys, foreignKeys, uniques, indexes] =
      await Promise.all([
        this.client.query(COLUMNS_SQL, [this.schema]),
        this.client.query(PRIMARY_KEYS_SQL, [this.schema]),
        this.client.query(FOREIGN_KEYS_SQL, [this.schema]),
        this.client.query(UNIQUE_COLUMNS_SQL, [this.schema]),
        this.client.query(INDEXES_SQL, [this.schema]),
      ]);

    return buildSourceSchema({
      columns: columns.rows as never,
      primaryKeys: primaryKeys.rows as never,
      foreignKeys: foreignKeys.rows as never,
      uniques: uniques.rows as never,
      indexes: indexes.rows as never,
    });
  }

  async close(): Promise<void> {
    await this.client.end();
  }
}

/**
 * Opens live introspection sessions against a source PostgreSQL database via
 * node-postgres. Introspects the `public` schema by default, or a specific
 * schema when one is supplied (used to reopen a previously generated backend
 * that lives in its own `gen_<id>` schema).
 */
export class PgSource implements SourceDbDriver {
  private readonly schema: string;

  constructor(options: { schema?: string } = {}) {
    this.schema = options.schema ?? 'public';
  }

  async connect(
    creds: DbCredentials,
    timeoutMs: number,
  ): Promise<SourceIntrospector> {
    const pg = (await import('pg')) as unknown as {
      Client: new (config: Record<string, unknown>) => PgClientLike;
    };

    const client = new pg.Client({
      host: creds.host,
      port: creds.port,
      database: creds.database,
      user: creds.user,
      password: creds.password,
      connectionTimeoutMillis: timeoutMs,
      ssl: { rejectUnauthorized: false },
    });

    try {
      await client.connect();
    } catch (error) {
      await client.end().catch(() => undefined);
      throw classifyConnectError(error);
    }

    return new PgIntrospector(client, this.schema);
  }
}
