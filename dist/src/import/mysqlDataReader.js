/**
 * Reads the actual rows out of a source MySQL database during an import, so the
 * "Import existing database" path migrates the **data** (not just the schema)
 * into the new Aurora/RDS PostgreSQL backend — the MySQL counterpart to
 * {@link ./pgDataReader.ts}.
 *
 * Best-effort: a failure to read a table never fails the import (the schema
 * still migrates), the table just arrives empty. The `mysql2` module is
 * imported lazily so this file loads without the optional dependency present.
 */
/** Safety cap on rows read per source table, to bound memory/time. */
const MAX_ROWS_PER_TABLE = 100_000;
/** Backtick-quote a MySQL identifier, escaping embedded backticks. */
function quoteIdent(name) {
    return '`' + name.replace(/`/g, '``') + '`';
}
/**
 * Read up to {@link MAX_ROWS_PER_TABLE} rows from each of `tables` in the
 * connected MySQL database, returning a map of table name -> rows. Tables that
 * error are skipped rather than failing the whole read.
 */
export async function readMySqlRows(creds, tables) {
    const out = new Map();
    if (tables.length === 0) {
        return out;
    }
    const mysql = (await import('mysql2/promise'));
    const conn = await mysql.createConnection({
        host: creds.host,
        port: creds.port,
        database: creds.database,
        user: creds.user,
        password: creds.password,
        connectTimeout: 30_000,
        dateStrings: true,
    });
    try {
        for (const table of tables) {
            try {
                const [rows] = await conn.query(`SELECT * FROM ${quoteIdent(table)} LIMIT ${MAX_ROWS_PER_TABLE}`);
                out.set(table, rows);
            }
            catch {
                // Skip unreadable tables; the schema still migrates.
            }
        }
    }
    finally {
        await conn.end().catch(() => undefined);
    }
    return out;
}
//# sourceMappingURL=mysqlDataReader.js.map