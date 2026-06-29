/**
 * Provisioner ports — the small dependency-injection boundary the
 * {@link Provisioner} is implemented against.
 *
 * The Provisioner's job (Req 4) is intrinsically about a live database: open a
 * connection within a deadline, run a migration inside a single transaction,
 * commit on full success or roll back on any failure. To keep that logic
 * unit-testable (Property 19 — failed migration rolls back completely) without
 * a live AWS connection, the Provisioner depends only on the abstract
 * {@link DbDriver} / {@link DbConnection} port defined here, plus an injectable
 * {@link Clock} for deterministic timeout logic.
 *
 * Two implementations of this port exist:
 * - {@link InMemoryDriver} (./inMemoryDriver.ts) — a transactional fake used by
 *   property/unit tests; it records applied statements and supports
 *   begin/commit/rollback so a rollback restores the prior state.
 * - A real node-postgres ('pg') backed adapter (./pgDriver.ts) — a thin
 *   wrapper supplied by integration tests / production. It is intentionally a
 *   marked placeholder so the build stays green without adding the `pg`
 *   dependency.
 *
 * Error discipline: a {@link DbConnection} / {@link DbDriver} is a low-level
 * adapter that mirrors a real driver, so its operations reject (throw) on
 * failure rather than returning a `Result`. The Provisioner is the boundary
 * that translates those rejections into a typed {@link DeployResult}. Failures
 * raised while connecting are classified as `CONNECTIVITY`; failures raised
 * while running the transaction are classified as `MIGRATION`.
 */
// ---------------------------------------------------------------------------
// Timeouts (the deadlines from Requirement 4)
// ---------------------------------------------------------------------------
/** Req 4.5 — fail with a connectivity error if a connection is not established within 30s. */
export const CONNECT_TIMEOUT_MS = 30_000;
/** Req 4.1 — the whole migration must be applied within a 300s ceiling. */
export const APPLY_CEILING_MS = 300_000;
/** The default wall-clock implementation used in production. */
export const systemClock = {
    now: () => Date.now(),
};
// ---------------------------------------------------------------------------
// Driver errors
// ---------------------------------------------------------------------------
/**
 * Raised by a {@link DbDriver} when a connection cannot be established (host
 * unreachable, credentials rejected, or the connect deadline elapsed). The
 * Provisioner maps this to a `CONNECTIVITY` {@link DeployResult}.
 */
export class ConnectivityError extends Error {
    constructor(message) {
        super(message);
        this.name = 'ConnectivityError';
    }
}
/**
 * Raised by a {@link DbConnection} when a statement (or begin/commit) fails
 * while applying a migration. The Provisioner maps this to a `MIGRATION`
 * {@link DeployResult} after rolling back.
 */
export class MigrationFailureError extends Error {
    constructor(message) {
        super(message);
        this.name = 'MigrationFailureError';
    }
}
//# sourceMappingURL=driver.js.map