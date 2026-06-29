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
import { type SourceDbDriver, type SourceIntrospector, type SourceSchema } from './sourceDriver.js';
/**
 * Assemble a {@link SourceSchema} from MySQL `information_schema` rows. Pure, so
 * it can be unit-tested without a live database.
 */
export declare function buildMysqlSourceSchema(rows: {
    columns: {
        TABLE_NAME: string;
        COLUMN_NAME: string;
        DATA_TYPE: string;
        IS_NULLABLE: string;
        COLUMN_KEY: string;
    }[];
    primaryKeys: {
        TABLE_NAME: string;
        COLUMN_NAME: string;
    }[];
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
}): SourceSchema;
/** Opens live introspection sessions against a source MySQL database. */
export declare class MySqlSource implements SourceDbDriver {
    connect(creds: DbCredentials, timeoutMs: number): Promise<SourceIntrospector>;
}
