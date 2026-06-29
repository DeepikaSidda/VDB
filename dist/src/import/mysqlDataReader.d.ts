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
import type { DbCredentials } from '../model/types.js';
/**
 * Read up to {@link MAX_ROWS_PER_TABLE} rows from each of `tables` in the
 * connected MySQL database, returning a map of table name -> rows. Tables that
 * error are skipped rather than failing the whole read.
 */
export declare function readMySqlRows(creds: DbCredentials, tables: readonly string[]): Promise<Map<string, Record<string, unknown>[]>>;
