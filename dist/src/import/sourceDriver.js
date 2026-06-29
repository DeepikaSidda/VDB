/**
 * Import_Analyzer ports — the small dependency-injection boundary the
 * {@link ImportAnalyzer} is implemented against (Requirement 11).
 *
 * Importing an existing database (Req 11.1) is intrinsically about a live
 * external MySQL/PostgreSQL connection: open a connection within a 30s
 * deadline, introspect its schema (tables/columns/types/PKs/FKs/indexes), and
 * distinguish a connection timeout from an authentication failure (Req 11.5).
 * To keep that logic unit-testable WITHOUT a live database — exactly like the
 * Provisioner (src/provisioner) — the analyzer depends only on the abstract
 * {@link SourceDbDriver} / {@link SourceIntrospector} port defined here, plus
 * an injectable {@link Clock} for deterministic timeout logic.
 *
 * Two implementations of this port exist:
 * - {@link InMemorySource} (./inMemorySource.ts) — a configurable fake used by
 *   property/unit tests; it returns a canned {@link SourceSchema} and can be
 *   steered into unreachable / timed-out / auth-rejected behavior.
 * - A real driver-backed adapter (./pgSource.ts) — a thin, marked placeholder
 *   so the build stays green without adding a live `pg`/`mysql2` dependency.
 *
 * Error discipline: a {@link SourceDbDriver} / {@link SourceIntrospector} is a
 * low-level adapter that mirrors a real driver, so its operations reject
 * (throw) on failure rather than returning a `Result`. The {@link
 * ImportAnalyzer} is the boundary that translates those rejections into a
 * typed {@link ImportError}: a {@link SourceConnectionTimeoutError} (or a
 * connect that blows the 30s window) becomes `CONNECTION_TIMEOUT`; a
 * {@link SourceAuthenticationError} becomes `AUTHENTICATION_FAILURE`
 * (Req 11.5).
 */
// ---------------------------------------------------------------------------
// Timeouts (the deadline from Requirement 11)
// ---------------------------------------------------------------------------
/** Req 11.1 / 11.5 — establish a connection within 30s, else a timeout. */
export const CONNECT_TIMEOUT_MS = 30_000;
/** The default wall-clock implementation used in production. */
export const systemClock = {
    now: () => Date.now(),
};
// ---------------------------------------------------------------------------
// Driver errors
// ---------------------------------------------------------------------------
/**
 * Raised by a {@link SourceDbDriver} when a connection cannot be established
 * within the connect deadline (host unreachable or the 30s window elapsed).
 * The {@link ImportAnalyzer} maps this to a `CONNECTION_TIMEOUT`
 * {@link ImportError} (Req 11.5).
 */
export class SourceConnectionTimeoutError extends Error {
    constructor(message) {
        super(message);
        this.name = 'SourceConnectionTimeoutError';
    }
}
/**
 * Raised by a {@link SourceDbDriver} when the provided credentials are
 * rejected. The {@link ImportAnalyzer} maps this to an
 * `AUTHENTICATION_FAILURE` {@link ImportError} (Req 11.5).
 */
export class SourceAuthenticationError extends Error {
    constructor(message) {
        super(message);
        this.name = 'SourceAuthenticationError';
    }
}
//# sourceMappingURL=sourceDriver.js.map