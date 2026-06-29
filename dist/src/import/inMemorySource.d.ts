/**
 * In-memory source database fake.
 *
 * A {@link SourceDbDriver} implementation backed by a canned
 * {@link SourceSchema} rather than a live MySQL/PostgreSQL database. It exists
 * so the {@link ImportAnalyzer} can be exercised deterministically — schema
 * extraction (Req 11.1), unsupported-element handling (Req 11.2), and the
 * connection-timeout-vs-authentication-failure distinction (Req 11.5) — without
 * a real connection.
 *
 * It can be configured to:
 * - be unreachable, so {@link SourceDbDriver.connect} fails with a
 *   {@link SourceConnectionTimeoutError} (connection-timeout tests);
 * - reject credentials, so connect fails with a
 *   {@link SourceAuthenticationError} (authentication-failure tests);
 * - take a simulated connect duration, advancing the shared {@link MutableClock}
 *   (connect-deadline tests);
 * - return a specific {@link SourceSchema} (extraction / suggestion tests).
 *
 * Determinism: the fake advances a shared {@link MutableClock} as it "connects",
 * and the {@link ImportAnalyzer} reads the same clock to enforce its 30s
 * deadline. Tests construct one {@link MutableClock}, hand it to both the fake
 * and the analyzer, and advance it implicitly through the configured duration.
 */
import type { DbCredentials } from '../model/types.js';
import { type Clock, type SourceDbDriver, type SourceIntrospector, type SourceSchema } from './sourceDriver.js';
/**
 * A {@link Clock} whose current time can be advanced explicitly. Shared between
 * the {@link InMemorySource} (which advances it to simulate a connect duration)
 * and the {@link ImportAnalyzer} (which reads it to enforce the connect
 * deadline).
 */
export declare class MutableClock implements Clock {
    private current;
    constructor(start?: number);
    now(): number;
    /** Advance the clock by `ms` milliseconds. */
    advance(ms: number): void;
    /** Set the clock to an absolute time. */
    set(ms: number): void;
}
/**
 * Tunables that let tests steer the fake into each behavior the
 * {@link ImportAnalyzer} must handle.
 */
export interface InMemorySourceConfig {
    /** The schema introspection returns. Defaults to an empty schema. */
    schema?: SourceSchema;
    /** Shared clock the fake advances as it simulates connecting. Defaults to a fresh one. */
    clock?: MutableClock;
    /** When false, {@link SourceDbDriver.connect} fails with a timeout. Defaults to true. */
    reachable?: boolean;
    /** When false, connect fails with an authentication error. Defaults to true. */
    authenticates?: boolean;
    /** Simulated time (ms) a connection attempt takes; advances the clock. Defaults to 0. */
    connectDurationMs?: number;
}
/**
 * The configurable in-memory source fake. Connecting honors the configured
 * reachability / authentication / duration so the analyzer's connect-phase
 * branches (Req 11.5) can be exercised; introspection returns the canned
 * schema so extraction and suggestion logic (Req 11.1–11.3) can be exercised.
 */
export declare class InMemorySource implements SourceDbDriver {
    readonly clock: MutableClock;
    private readonly config;
    constructor(config?: InMemorySourceConfig);
    connect(_creds: DbCredentials, timeoutMs: number): Promise<SourceIntrospector>;
}
