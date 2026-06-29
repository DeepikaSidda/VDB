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
import {
  type Clock,
  type DbConnection,
  type DbDriver,
  ConnectivityError,
  MigrationFailureError,
} from './driver.js';

// ---------------------------------------------------------------------------
// MutableClock — a clock tests (and the fake) can advance
// ---------------------------------------------------------------------------

/**
 * A {@link Clock} whose current time can be advanced explicitly. Shared between
 * the {@link InMemoryDriver} (which advances it to simulate connect/exec
 * durations) and the {@link Provisioner} (which reads it to enforce deadlines).
 */
export class MutableClock implements Clock {
  private current: number;

  constructor(start = 0) {
    this.current = start;
  }

  now(): number {
    return this.current;
  }

  /** Advance the clock by `ms` milliseconds. */
  advance(ms: number): void {
    this.current += ms;
  }

  /** Set the clock to an absolute time. */
  set(ms: number): void {
    this.current = ms;
  }
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Connection
// ---------------------------------------------------------------------------

class InMemoryConnection implements DbConnection {
  /** Statements executed since the current `begin`, not yet committed. */
  private pending: DdlStatement[] = [];
  private inTransaction = false;
  private execIndex = 0;
  private closed = false;

  constructor(
    private readonly driver: InMemoryDriver,
    private readonly clock: MutableClock,
    private readonly config: InMemoryDriverConfig,
  ) {}

  async begin(): Promise<void> {
    this.assertOpen();
    this.inTransaction = true;
    this.pending = [];
    this.execIndex = 0;
  }

  async exec(statement: DdlStatement): Promise<void> {
    this.assertOpen();
    if (!this.inTransaction) {
      throw new MigrationFailureError('exec called outside a transaction');
    }
    const index = this.execIndex++;
    if (this.config.execDurationMs) {
      this.clock.advance(this.config.execDurationMs);
    }
    if (this.config.failOnStatement?.(statement, index)) {
      throw new MigrationFailureError(
        `statement ${index} failed: ${statement.sql}`,
      );
    }
    // Buffer the statement; it only becomes durable on commit.
    this.pending.push(statement);
  }

  async commit(): Promise<void> {
    this.assertOpen();
    if (!this.inTransaction) {
      throw new MigrationFailureError('commit called outside a transaction');
    }
    // Durably apply every buffered statement (all-or-nothing).
    this.driver.appendCommitted(this.pending);
    this.pending = [];
    this.inTransaction = false;
  }

  async rollback(): Promise<void> {
    // Discard every buffered statement; the durable state is untouched, so the
    // target is restored to its pre-migration state (Req 4.4).
    this.pending = [];
    this.inTransaction = false;
  }

  async close(): Promise<void> {
    this.closed = true;
  }

  private assertOpen(): void {
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
export class InMemoryDriver implements DbDriver {
  readonly clock: MutableClock;
  private readonly config: InMemoryDriverConfig;
  /** Durably committed statements — the applied schema. */
  private committed: DdlStatement[] = [];

  constructor(config: InMemoryDriverConfig = {}) {
    this.config = config;
    this.clock = config.clock ?? new MutableClock();
  }

  async connect(
    target: DeploymentTarget,
    timeoutMs: number,
  ): Promise<DbConnection> {
    const duration = this.config.connectDurationMs ?? 0;
    if (duration > 0) {
      this.clock.advance(duration);
    }
    if (this.config.reachable === false) {
      throw new ConnectivityError(
        `unable to reach ${target.connection.host}:${target.connection.port}`,
      );
    }
    if (duration > timeoutMs) {
      throw new ConnectivityError(
        `connection timed out after ${timeoutMs}ms`,
      );
    }
    return new InMemoryConnection(this, this.clock, this.config);
  }

  /** Internal: durably append committed statements. Called on commit. */
  appendCommitted(statements: readonly DdlStatement[]): void {
    this.committed.push(...statements);
  }

  /**
   * The statements durably applied to the target so far. Tests assert on this
   * to confirm a rollback restored the prior (here, empty) state.
   */
  appliedStatements(): readonly DdlStatement[] {
    return [...this.committed];
  }
}
