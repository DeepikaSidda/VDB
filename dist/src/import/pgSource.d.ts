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
import { type SourceDbDriver, type SourceIntrospector, type SourceSchema } from './sourceDriver.js';
/**
 * Assemble a {@link SourceSchema} from the raw introspection rows. Pure so it
 * can be unit-tested without a database.
 */
export declare function buildSourceSchema(rows: {
    columns: {
        table_name: string;
        column_name: string;
        data_type: string;
        is_nullable: string;
    }[];
    primaryKeys: {
        table_name: string;
        column_name: string;
    }[];
    foreignKeys: {
        table_name: string;
        column_name: string;
        references_table: string;
        references_column: string;
    }[];
    uniques: {
        table_name: string;
        column_name: string;
    }[];
    indexes: {
        table_name: string;
        index_name: string;
        indexdef: string;
    }[];
}): SourceSchema;
/**
 * Opens live introspection sessions against a source PostgreSQL database via
 * node-postgres. Introspects the `public` schema by default, or a specific
 * schema when one is supplied (used to reopen a previously generated backend
 * that lives in its own `gen_<id>` schema).
 */
export declare class PgSource implements SourceDbDriver {
    private readonly schema;
    constructor(options?: {
        schema?: string;
    });
    connect(creds: DbCredentials, timeoutMs: number): Promise<SourceIntrospector>;
}
