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
import type { DeploymentTarget } from '../model/types.js';
import { type DbConnection, type DbDriver } from './driver.js';
/**
 * Opens live connections to an Amazon Aurora PostgreSQL Deployment_Target using
 * node-postgres. Construct once and reuse; each {@link connect} call yields a
 * fresh single-use connection for one migration.
 */
export declare class PgDriver implements DbDriver {
    /** Per-statement server-side timeout (ms). Defaults to the 300s apply ceiling. */
    private readonly statementTimeoutMs;
    /** Prefix for the per-generation schema each deploy is isolated into. */
    private readonly schemaPrefix;
    /**
     * When set, every connection deploys into exactly this schema instead of a
     * freshly randomized one. The pipeline supplies a fixed name so the data
     * seeding pass can INSERT into the same schema the migration created.
     */
    private readonly fixedSchemaName?;
    constructor(options?: {
        statementTimeoutMs?: number;
        schemaPrefix?: string;
        schemaName?: string;
    });
    connect(target: DeploymentTarget, timeoutMs: number): Promise<DbConnection>;
}
