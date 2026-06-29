/**
 * Real node-postgres ('pg') backed {@link DbDriver}.
 *
 * This is the production adapter the Provisioner uses to apply a generated
 * migration to a live Amazon Aurora PostgreSQL Deployment_Target. It implements
 * the same {@link DbConnection} / {@link DbDriver} port the in-memory fake does,
 * so the Provisioner's transactional logic (BEGIN → exec* → COMMIT, ROLLBACK on
 * any failure) is unchanged — only the backing connection differs.
 *
 * Connection + transaction semantics (Requirement 4):
 * - `connect` opens a single `pg` Client with `connectionTimeoutMillis` set to
 *   the connect deadline (Req 4.5) and `statement_timeout` set to the apply
 *   ceiling (Req 4.1) as a server-side backstop. A failure to connect is
 *   raised as a {@link ConnectivityError}, which the Provisioner maps to a
 *   `CONNECTIVITY` DeployResult.
 * - Because PostgreSQL DDL is transactional, wrapping every statement in a
 *   single BEGIN/COMMIT (with ROLLBACK on error) gives the atomic apply +
 *   restore-to-prior-state guarantee of Req 4.2–4.4 for free.
 *
 * The `pg` module is imported lazily inside `connect` so importing this file
 * never fails when the optional dependency is absent (e.g. in a pure unit-test
 * environment that only uses the in-memory driver).
 */
import { ConnectivityError, MigrationFailureError, } from './driver.js';
/** PostgreSQL SQLSTATE classes/codes that indicate an authentication failure. */
const AUTH_SQLSTATES = new Set(['28000', '28P01']);
/**
 * Whether a thrown `pg` error looks like an authentication failure (bad
 * password / role). For the Provisioner these still surface as connectivity
 * failures, but the classification is shared with {@link toConnectivityError}.
 */
function isAuthError(error) {
    const code = error?.code;
    return typeof code === 'string' && AUTH_SQLSTATES.has(code);
}
function messageOf(error) {
    if (error instanceof Error) {
        return error.message;
    }
    return String(error);
}
function toConnectivityError(error) {
    const prefix = isAuthError(error)
        ? 'authentication failed'
        : 'could not connect to the Deployment_Target';
    return new ConnectivityError(`${prefix}: ${messageOf(error)}`);
}
/** Double-quote a PostgreSQL identifier, escaping embedded quotes. */
function quoteIdent(name) {
    return `"${name.replace(/"/g, '""')}"`;
}
/** A unique, valid PostgreSQL schema name for one generation. */
function uniqueSchemaName(prefix) {
    const stamp = Date.now().toString(36);
    const rand = Math.random().toString(36).slice(2, 8);
    return `${prefix}_${stamp}_${rand}`;
}
/**
 * A {@link DbConnection} backed by a live `pg` Client. Each method maps onto a
 * SQL command; `exec` runs one migration statement and rejects (which the
 * Provisioner turns into a rollback + `MIGRATION` failure) if it errors.
 *
 * Each connection deploys into its own freshly-created PostgreSQL **schema**
 * (e.g. `gen_<id>`) by creating it and setting `search_path` at the start of
 * the transaction. This isolates every generated backend so repeated
 * generations — even of the same domain with the same entity names — never
 * collide in a single persistent database. Because `CREATE SCHEMA` is itself
 * transactional, a failed migration rolls the schema back too (fail-closed).
 */
class PgConnection {
    client;
    schema;
    constructor(client, schema) {
        this.client = client;
        this.schema = schema;
    }
    async begin() {
        await this.client.query('BEGIN');
        await this.client.query(`CREATE SCHEMA ${quoteIdent(this.schema)}`);
        // Subsequent unqualified CREATE TABLE statements land in this schema.
        await this.client.query(`SET search_path TO ${quoteIdent(this.schema)}`);
    }
    async exec(statement) {
        try {
            await this.client.query(statement.sql);
        }
        catch (error) {
            throw new MigrationFailureError(messageOf(error));
        }
    }
    async commit() {
        await this.client.query('COMMIT');
    }
    async rollback() {
        await this.client.query('ROLLBACK');
    }
    async close() {
        await this.client.end();
    }
}
/**
 * Opens live connections to an Amazon Aurora PostgreSQL Deployment_Target using
 * node-postgres. Construct once and reuse; each {@link connect} call yields a
 * fresh single-use connection for one migration.
 */
export class PgDriver {
    /** Per-statement server-side timeout (ms). Defaults to the 300s apply ceiling. */
    statementTimeoutMs;
    /** Prefix for the per-generation schema each deploy is isolated into. */
    schemaPrefix;
    /**
     * When set, every connection deploys into exactly this schema instead of a
     * freshly randomized one. The pipeline supplies a fixed name so the data
     * seeding pass can INSERT into the same schema the migration created.
     */
    fixedSchemaName;
    constructor(options = {}) {
        this.statementTimeoutMs = options.statementTimeoutMs ?? 300_000;
        this.schemaPrefix = options.schemaPrefix ?? 'gen';
        this.fixedSchemaName = options.schemaName;
    }
    async connect(target, timeoutMs) {
        // Lazy import so this module is safe to load without the optional `pg`
        // dependency present.
        const pg = (await import('pg'));
        const client = new pg.Client({
            host: target.connection.host,
            port: target.connection.port,
            database: target.connection.database,
            user: target.connection.user,
            password: target.connection.password,
            connectionTimeoutMillis: timeoutMs,
            statement_timeout: this.statementTimeoutMs,
            // Aurora PostgreSQL endpoints require TLS; allow the platform CA chain.
            ssl: { rejectUnauthorized: false },
        });
        try {
            await client.connect();
        }
        catch (error) {
            // Best-effort cleanup; the connect failed so end() may also reject.
            await client.end().catch(() => undefined);
            throw toConnectivityError(error);
        }
        return new PgConnection(client, this.fixedSchemaName ?? uniqueSchemaName(this.schemaPrefix));
    }
}
//# sourceMappingURL=pgDriver.js.map