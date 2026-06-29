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

import type { DdlStatement, DeploymentTarget } from '../model/types.js';

// ---------------------------------------------------------------------------
// Timeouts (the deadlines from Requirement 4)
// ---------------------------------------------------------------------------

/** Req 4.5 — fail with a connectivity error if a connection is not established within 30s. */
export const CONNECT_TIMEOUT_MS = 30_000;

/** Req 4.1 — the whole migration must be applied within a 300s ceiling. */
export const APPLY_CEILING_MS = 300_000;

// ---------------------------------------------------------------------------
// Clock (injectable for deterministic timeout tests)
// ---------------------------------------------------------------------------

/**
 * A monotonic source of "current time" in milliseconds. Injected into the
 * Provisioner so the 30s connect deadline and 300s apply ceiling are
 * deterministically testable: tests supply a clock they can advance, and the
 * {@link InMemoryDriver} advances the same clock as it simulates work.
 */
export interface Clock {
  /** Current time in milliseconds. */
  now(): number;
}

/** The default wall-clock implementation used in production. */
export const systemClock: Clock = {
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
  constructor(message: string) {
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
  constructor(message: string) {
    super(message);
    this.name = 'MigrationFailureError';
  }
}

// ---------------------------------------------------------------------------
// The port
// ---------------------------------------------------------------------------

/**
 * An open transactional connection to a Deployment_Target.
 *
 * Transaction semantics the Provisioner relies on:
 * - {@link begin} opens a transaction; the state visible after a later
 *   {@link rollback} must equal the state at the moment `begin` was called.
 * - {@link exec} applies a single DDL statement within the open transaction
 *   and rejects if the statement fails.
 * - {@link commit} durably applies every executed statement (all-or-nothing).
 * - {@link rollback} discards every statement executed since `begin`, restoring
 *   the pre-migration state (Req 4.4).
 */
export interface DbConnection {
  /** Open a transaction. */
  begin(): Promise<void>;
  /** Apply one DDL statement inside the open transaction; rejects on failure. */
  exec(statement: DdlStatement): Promise<void>;
  /** Durably commit every statement executed since {@link begin}. */
  commit(): Promise<void>;
  /** Discard every statement executed since {@link begin}, restoring prior state. */
  rollback(): Promise<void>;
  /** Release the connection. Safe to call once after commit or rollback. */
  close(): Promise<void>;
}

/**
 * Opens connections to a Deployment_Target. Implementations connect to the
 * concrete database (a real `pg` pool in production, an in-memory store in
 * tests).
 */
export interface DbDriver {
  /**
   * Establish a connection to {@link target}, giving up after
   * {@link timeoutMs}. Rejects with a {@link ConnectivityError} if the
   * connection cannot be established within the deadline.
   */
  connect(target: DeploymentTarget, timeoutMs: number): Promise<DbConnection>;
}
