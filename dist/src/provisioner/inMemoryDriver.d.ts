/**
 * In-memory transactional fake driver.
 *
 * A {@link DbDriver} implementation backed by an in-memory list of "applied"
 * statements rather than a live database. It exists so the {@link Provisioner}
 * can be exercised deterministically — in particular it backs Property 19
 * (failed migration rolls back completely): a rollback discards every statement
 * executed since `begin`, restoring the exact pre-migration state.
 *
 * It can be configured to:
 * - be unreachable, so {@link DbDriver.connect} fails (connectivity tests);
 * - take a simulated connect duration, advancing the shared {@link MutableClock}
 *   (connect-deadline tests);
 * - fail on a specific statement, so the transaction aborts mid-migration
 *   (rollback tests);
 * - take a simulated per-statement duration, advancing the clock (apply-ceiling
 *   tests).
 *
 * Determinism: the fake advances a shared {@link MutableClock} as it "works", and
 * the Provisioner reads the same clock to enforce its deadlines. Tests construct
 * one {@link MutableClock}, hand it to both the fake and the Provisioner, and
 * advance it implicitly through the configured durations.
 */
import type { DdlStatement, DeploymentTarget } from '../model/types.js';
import { type Clock, type DbConnection, type DbDriver } from './driver.js';
/**
 * A {@link Clock} whose current time can be advanced explicitly. Shared between
 * the {@link InMemoryDriver} (which advances it to simulate connect/exec
 * durations) and the {@link Provisioner} (which reads it to enforce deadlines).
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
 * Tunables that let tests steer the fake into each behavior the Provisioner
 * must handle.
 */
export interface InMemoryDriverConfig {
    /** Shared clock the fake advances as it simulates work. Defaults to a fresh one. */
    clock?: MutableClock;
    /** When false, {@link DbDriver.connect} fails with a {@link ConnectivityError}. Defaults to true. */
    reachable?: boolean;
    /** Simulated time (ms) a connection attempt takes; advances the clock. Defaults to 0. */
    connectDurationMs?: number;
    /** Simulated time (ms) each statement takes; advances the clock. Defaults to 0. */
    execDurationMs?: number;
    /**
     * Predicate selecting a statement that should fail when executed, aborting
     * the transaction. Receives the statement and its zero-based index.
     */
    failOnStatement?: (statement: DdlStatement, index: number) => boolean;
}
/**
 * The transactional in-memory fake. Holds the durable "committed" statements
 * (the schema that has actually been applied). A rollback never touches this
 * list, which is what makes a failed migration leave no trace.
 */
export declare class InMemoryDriver implements DbDriver {
    readonly clock: MutableClock;
    private readonly config;
    /** Durably committed statements — the applied schema. */
    private committed;
    constructor(config?: InMemoryDriverConfig);
    connect(target: DeploymentTarget, timeoutMs: number): Promise<DbConnection>;
    /** Internal: durably append committed statements. Called on commit. */
    appendCommitted(statements: readonly DdlStatement[]): void;
    /**
     * The statements durably applied to the target so far. Tests assert on this
     * to confirm a rollback restored the prior (here, empty) state.
     */
    appliedStatements(): readonly DdlStatement[];
}
