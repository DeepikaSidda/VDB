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
import type { DbCredentials } from '../model/types.js';
/**
 * Read up to {@link MAX_ROWS_PER_TABLE} rows from each of `tables` in the given
 * source `schema`, returning a map of table name -> rows. Tables that error
 * (e.g. permissions) are skipped rather than failing the whole read.
 */
export declare function readPostgresRows(creds: DbCredentials, schema: string, tables: readonly string[]): Promise<Map<string, Record<string, unknown>[]>>;
