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
import { SourceAuthenticationError, SourceConnectionTimeoutError, } from './sourceDriver.js';
const AUTH_ERRNOS = new Set([1044, 1045]);
function messageOf(error) {
    return error instanceof Error ? error.message : String(error);
}
function classifyConnectError(error) {
    const errno = error.errno;
    const code = error.code;
    if ((typeof errno === 'number' && AUTH_ERRNOS.has(errno)) ||
        code === 'ER_ACCESS_DENIED_ERROR' ||
        code === 'ER_DBACCESS_DENIED_ERROR') {
        return new SourceAuthenticationError(`authentication failed: ${messageOf(error)}`);
    }
    return new SourceConnectionTimeoutError(`could not reach the source database: ${messageOf(error)}`);
}
// ---------------------------------------------------------------------------
// Pure schema assembly (offline-testable)
// ---------------------------------------------------------------------------
/**
 * Assemble a {@link SourceSchema} from MySQL `information_schema` rows. Pure, so
 * it can be unit-tested without a live database.
 */
export function buildMysqlSourceSchema(rows) {
    const tables = new Map();
    const tableFor = (name) => {
        let t = tables.get(name);
        if (t === undefined) {
            t = { name, columns: [], primaryKey: [], foreignKeys: [], indexes: [] };
            tables.set(name, t);
        }
        return t;
    };
    for (const c of rows.columns) {
        const column = {
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
        const ref = {
            column: fk.COLUMN_NAME,
            referencesTable: fk.REFERENCED_TABLE_NAME,
            referencesColumn: fk.REFERENCED_COLUMN_NAME,
        };
        tableFor(fk.TABLE_NAME).foreignKeys.push(ref);
    }
    // Group index rows (one row per indexed column) into SourceIndex entries.
    const idxByKey = new Map();
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
class MysqlIntrospector {
    conn;
    constructor(conn) {
        this.conn = conn;
    }
    async introspect() {
        const [columns] = await this.conn.query(COLUMNS_SQL);
        const [primaryKeys] = await this.conn.query(PRIMARY_KEYS_SQL);
        const [foreignKeys] = await this.conn.query(FOREIGN_KEYS_SQL);
        const [indexes] = await this.conn.query(INDEXES_SQL);
        return buildMysqlSourceSchema({
            columns: columns,
            primaryKeys: primaryKeys,
            foreignKeys: foreignKeys,
            indexes: indexes,
        });
    }
    async close() {
        await this.conn.end();
    }
}
/** Opens live introspection sessions against a source MySQL database. */
export class MySqlSource {
    async connect(creds, timeoutMs) {
        const mysql = (await import('mysql2/promise'));
        let conn;
        try {
            conn = await mysql.createConnection({
                host: creds.host,
                port: creds.port,
                database: creds.database,
                user: creds.user,
                password: creds.password,
                connectTimeout: timeoutMs,
            });
        }
        catch (error) {
            throw classifyConnectError(error);
        }
        return new MysqlIntrospector(conn);
    }
}
//# sourceMappingURL=mysqlSource.js.map