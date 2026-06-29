/**
 * Reads the actual rows out of a source PostgreSQL database during an import,
 * so the "Import existing database" path can migrate the **data** into the new
 * Aurora/RDS backend — not just the schema (Requirement 11, data-copy
 * extension). The schema itself is introspected separately by {@link PgSource};
 * this module is only concerned with bulk-reading table contents.
 *
 * It is deliberately separate and best-effort: a failure to read a table's rows
 * never fails the import (the schema migration still succeeds), it just means
 * that table arrives empty.
 *
 * The `pg` module is imported lazily so loading this file never fails when the
 * optional dependency is absent.
 */
/** Safety cap on rows read per source table, to bound memory/time. */
const MAX_ROWS_PER_TABLE = 100_000;
function quoteIdent(name) {
    return `"${name.replace(/"/g, '""')}"`;
}
/**
 * Read up to {@link MAX_ROWS_PER_TABLE} rows from each of `tables` in the given
 * source `schema`, returning a map of table name -> rows. Tables that error
 * (e.g. permissions) are skipped rather than failing the whole read.
 */
export async function readPostgresRows(creds, schema, tables) {
    const out = new Map();
    if (tables.length === 0) {
        return out;
    }
    const pg = (await import('pg'));
    const client = new pg.Client({
        host: creds.host,
        port: creds.port,
        database: creds.database,
        user: creds.user,
        password: creds.password,
        connectionTimeoutMillis: 30_000,
        ssl: { rejectUnauthorized: false },
    });
    await client.connect();
    try {
        for (const table of tables) {
            try {
                const res = await client.query(`SELECT * FROM ${quoteIdent(schema)}.${quoteIdent(table)} LIMIT ${MAX_ROWS_PER_TABLE}`);
                out.set(table, res.rows);
            }
            catch {
                // Skip unreadable tables; the schema still migrates.
            }
        }
    }
    finally {
        await client.end().catch(() => undefined);
    }
    return out;
}
//# sourceMappingURL=pgDataReader.js.map