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
import { ConnectivityError, MigrationFailureError, } from './driver.js';
// ---------------------------------------------------------------------------
// MutableClock — a clock tests (and the fake) can advance
// ---------------------------------------------------------------------------
/**
 * A {@link Clock} whose current time can be advanced explicitly. Shared between
 * the {@link InMemoryDriver} (which advances it to simulate connect/exec
 * durations) and the {@link Provisioner} (which reads it to enforce deadlines).
 */
export class MutableClock {
    current;
    constructor(start = 0) {
        this.current = start;
    }
    now() {
        return this.current;
    }
    /** Advance the clock by `ms` milliseconds. */
    advance(ms) {
        this.current += ms;
    }
    /** Set the clock to an absolute time. */
    set(ms) {
        this.current = ms;
    }
}
// ---------------------------------------------------------------------------
// Connection
// ---------------------------------------------------------------------------
class InMemoryConnection {
    driver;
    clock;
    config;
    /** Statements executed since the current `begin`, not yet committed. */
    pending = [];
    inTransaction = false;
    execIndex = 0;
    closed = false;
    constructor(driver, clock, config) {
        this.driver = driver;
        this.clock = clock;
        this.config = config;
    }
    async begin() {
        this.assertOpen();
        this.inTransaction = true;
        this.pending = [];
        this.execIndex = 0;
    }
    async exec(statement) {
        this.assertOpen();
        if (!this.inTransaction) {
            throw new MigrationFailureError('exec called outside a transaction');
        }
        const index = this.execIndex++;
        if (this.config.execDurationMs) {
            this.clock.advance(this.config.execDurationMs);
        }
        if (this.config.failOnStatement?.(statement, index)) {
            throw new MigrationFailureError(`statement ${index} failed: ${statement.sql}`);
        }
        // Buffer the statement; it only becomes durable on commit.
        this.pending.push(statement);
    }
    async commit() {
        this.assertOpen();
        if (!this.inTransaction) {
            throw new MigrationFailureError('commit called outside a transaction');
        }
        // Durably apply every buffered statement (all-or-nothing).
        this.driver.appendCommitted(this.pending);
        this.pending = [];
        this.inTransaction = false;
    }
    async rollback() {
        // Discard every buffered statement; the durable state is untouched, so the
        // target is restored to its pre-migration state (Req 4.4).
        this.pending = [];
        this.inTransaction = false;
    }
    async close() {
        this.closed = true;
    }
    assertOpen() {
        if (this.closed) {
            throw new MigrationFailureError('connection is closed');
        }
    }
}
// ---------------------------------------------------------------------------
// Driver
// ---------------------------------------------------------------------------
/**
 * The transactional in-memory fake. Holds the durable "committed" statements
 * (the schema that has actually been applied). A rollback never touches this
 * list, which is what makes a failed migration leave no trace.
 */
export class InMemoryDriver {
    clock;
    config;
    /** Durably committed statements — the applied schema. */
    committed = [];
    constructor(config = {}) {
        this.config = config;
        this.clock = config.clock ?? new MutableClock();
    }
    async connect(target, timeoutMs) {
        const duration = this.config.connectDurationMs ?? 0;
        if (duration > 0) {
            this.clock.advance(duration);
        }
        if (this.config.reachable === false) {
            throw new ConnectivityError(`unable to reach ${target.connection.host}:${target.connection.port}`);
        }
        if (duration > timeoutMs) {
            throw new ConnectivityError(`connection timed out after ${timeoutMs}ms`);
        }
        return new InMemoryConnection(this, this.clock, this.config);
    }
    /** Internal: durably append committed statements. Called on commit. */
    appendCommitted(statements) {
        this.committed.push(...statements);
    }
    /**
     * The statements durably applied to the target so far. Tests assert on this
     * to confirm a rollback restored the prior (here, empty) state.
     */
    appliedStatements() {
        return [...this.committed];
    }
}
//# sourceMappingURL=inMemoryDriver.js.map