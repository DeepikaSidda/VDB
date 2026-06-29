/**
 * Real `mysql2`-backed {@link SourceDbDriver} for importing an existing MySQL
 * database (Requirement 11) and migrating it to Aurora PostgreSQL.
 *
 * Implements the same introspection port as {@link import('./pgSource.js').PgSource},
 * so the Import_Analyzer's mapping + suggestion logic is identical regardless of
 * source engine. Connection failures are classified per Req 11.5: MySQL access-
 * denied (errno 1044/1045) → {@link SourceAuthenticationError}; anything else →
 * {@link SourceConnectionTimeoutError}.
 *
 * The `mysql2` module is imported lazily so this file loads without the optional
 * dependency present. The pure schema assembler {@link buildMysqlSourceSchema}
 * is exported for offline unit testing.
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

/** The subset of a `mysql2/promise` connection the adapter relies on. */
interface MysqlConnLike {
  query<R = Record<string, unknown>>(sql: string): Promise<[R[], unknown]>;
  end(): Promise<void>;
}

const AUTH_ERRNOS = new Set([1044, 1045]);

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function classifyConnectError(
  error: unknown,
): SourceAuthenticationError | SourceConnectionTimeoutError {
  const errno = (error as { errno?: unknown }).errno;
  const code = (error as { code?: unknown }).code;
  if (
    (typeof errno === 'number' && AUTH_ERRNOS.has(errno)) ||
    code === 'ER_ACCESS_DENIED_ERROR' ||
    code === 'ER_DBACCESS_DENIED_ERROR'
  ) {
    return new SourceAuthenticationError(
      `authentication failed: ${messageOf(error)}`,
    );
  }
  return new SourceConnectionTimeoutError(
    `could not reach the source database: ${messageOf(error)}`,
  );
}

// ---------------------------------------------------------------------------
// Pure schema assembly (offline-testable)
// ---------------------------------------------------------------------------

/**
 * Assemble a {@link SourceSchema} from MySQL `information_schema` rows. Pure, so
 * it can be unit-tested without a live database.
 */
export function buildMysqlSourceSchema(rows: {
  columns: {
    TABLE_NAME: string;
    COLUMN_NAME: string;
    DATA_TYPE: string;
    IS_NULLABLE: string;
    COLUMN_KEY: string;
  }[];
  primaryKeys: { TABLE_NAME: string; COLUMN_NAME: string }[];
  foreignKeys: {
    TABLE_NAME: string;
    COLUMN_NAME: string;
    REFERENCED_TABLE_NAME: string;
    REFERENCED_COLUMN_NAME: string;
  }[];
  indexes: {
    TABLE_NAME: string;
    INDEX_NAME: string;
    COLUMN_NAME: string;
    NON_UNIQUE: number;
  }[];
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

  for (const c of rows.columns) {
    const column: SourceColumn = {
      name: c.COLUMN_NAME,
      sourceType: c.DATA_TYPE,
      nullable: c.IS_NULLABLE === 'YES',
      unique: c.COLUMN_KEY === 'UNI' || c.COLUMN_KEY === 'PRI',
    };
    tableFor(c.TABLE_NAME).columns.push(column);
  }
  for (const pk of rows.primaryKeys) {
    tableFor(pk.TABLE_NAME).primaryKey.push(pk.COLUMN_NAME);
  }
  for (const fk of rows.foreignKeys) {
    const ref: SourceForeignKey = {
      column: fk.COLUMN_NAME,
      referencesTable: fk.REFERENCED_TABLE_NAME,
      referencesColumn: fk.REFERENCED_COLUMN_NAME,
    };
    tableFor(fk.TABLE_NAME).foreignKeys.push(ref);
  }

  // Group index rows (one row per indexed column) into SourceIndex entries.
  const idxByKey = new Map<string, SourceIndex>();
  for (const row of rows.indexes) {
    const key = `${row.TABLE_NAME}\u0000${row.INDEX_NAME}`;
    let idx = idxByKey.get(key);
    if (idx === undefined) {
      idx = { name: row.INDEX_NAME, columns: [], unique: row.NON_UNIQUE === 0 };
      idxByKey.set(key, idx);
      tableFor(row.TABLE_NAME).indexes.push(idx);
    }
    idx.columns.push(row.COLUMN_NAME);
  }

  return { tables: [...tables.values()] };
}

// ---------------------------------------------------------------------------
// Introspection queries (current schema only)
// ---------------------------------------------------------------------------

const COLUMNS_SQL = `
  SELECT TABLE_NAME, COLUMN_NAME, DATA_TYPE, IS_NULLABLE, COLUMN_KEY
  FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
  ORDER BY TABLE_NAME, ORDINAL_POSITION;`;

const PRIMARY_KEYS_SQL = `
  SELECT k.TABLE_NAME, k.COLUMN_NAME
  FROM information_schema.TABLE_CONSTRAINTS t
  JOIN information_schema.KEY_COLUMN_USAGE k
    ON t.CONSTRAINT_NAME = k.CONSTRAINT_NAME
   AND t.TABLE_SCHEMA = k.TABLE_SCHEMA AND t.TABLE_NAME = k.TABLE_NAME
  WHERE t.CONSTRAINT_TYPE = 'PRIMARY KEY' AND t.TABLE_SCHEMA = DATABASE()
  ORDER BY k.TABLE_NAME, k.ORDINAL_POSITION;`;

const FOREIGN_KEYS_SQL = `
  SELECT TABLE_NAME, COLUMN_NAME, REFERENCED_TABLE_NAME, REFERENCED_COLUMN_NAME
  FROM information_schema.KEY_COLUMN_USAGE
  WHERE TABLE_SCHEMA = DATABASE() AND REFERENCED_TABLE_NAME IS NOT NULL;`;

const INDEXES_SQL = `
  SELECT TABLE_NAME, INDEX_NAME, COLUMN_NAME, NON_UNIQUE
  FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE()
  ORDER BY TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX;`;

class MysqlIntrospector implements SourceIntrospector {
  constructor(private readonly conn: MysqlConnLike) {}

  async introspect(): Promise<SourceSchema> {
    const [columns] = await this.conn.query(COLUMNS_SQL);
    const [primaryKeys] = await this.conn.query(PRIMARY_KEYS_SQL);
    const [foreignKeys] = await this.conn.query(FOREIGN_KEYS_SQL);
    const [indexes] = await this.conn.query(INDEXES_SQL);
    return buildMysqlSourceSchema({
      columns: columns as never,
      primaryKeys: primaryKeys as never,
      foreignKeys: foreignKeys as never,
      indexes: indexes as never,
    });
  }

  async close(): Promise<void> {
    await this.conn.end();
  }
}

/** Opens live introspection sessions against a source MySQL database. */
export class MySqlSource implements SourceDbDriver {
  async connect(
    creds: DbCredentials,
    timeoutMs: number,
  ): Promise<SourceIntrospector> {
    const mysql = (await import('mysql2/promise')) as unknown as {
      createConnection: (config: Record<string, unknown>) => Promise<MysqlConnLike>;
    };

    let conn: MysqlConnLike;
    try {
      conn = await mysql.createConnection({
        host: creds.host,
        port: creds.port,
        database: creds.database,
        user: creds.user,
        password: creds.password,
        connectTimeout: timeoutMs,
      });
    } catch (error) {
      throw classifyConnectError(error);
    }
    return new MysqlIntrospector(conn);
  }
}
