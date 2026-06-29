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

import type { DbCredentials } from '../model/types.js';

// ---------------------------------------------------------------------------
// Timeouts (the deadline from Requirement 11)
// ---------------------------------------------------------------------------

/** Req 11.1 / 11.5 — establish a connection within 30s, else a timeout. */
export const CONNECT_TIMEOUT_MS = 30_000;

// ---------------------------------------------------------------------------
// Clock (injectable for deterministic timeout tests)
// ---------------------------------------------------------------------------

/**
 * A monotonic source of "current time" in milliseconds. Injected into the
 * {@link ImportAnalyzer} so the 30s connect deadline is deterministically
 * testable: tests supply a clock they can advance, and {@link InMemorySource}
 * advances the same clock as it simulates a connection attempt.
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
// Source schema introspection shape
// ---------------------------------------------------------------------------

/**
 * A single column as reported by the source database's introspection.
 * `sourceType` is the RAW source dialect type string (e.g. `varchar(255)`,
 * `int unsigned`, `serial`, `jsonb`); the {@link ImportAnalyzer} maps it to a
 * Data_Model {@link import('../model/types.js').DataType} where possible and
 * records it as not-extracted otherwise (Req 11.2).
 */
export interface SourceColumn {
  name: string;
  /** Raw source dialect type string, exactly as introspected. */
  sourceType: string;
  /** Whether the column accepts NULL. `false` -> a NOT_NULL constraint. */
  nullable: boolean;
  /** Whether the column carries a UNIQUE constraint. */
  unique: boolean;
}

/** A foreign key reported by the source database. */
export interface SourceForeignKey {
  /** The column on this table that holds the foreign key. */
  column: string;
  /** The referenced table. */
  referencesTable: string;
  /** The referenced column (typically the referenced table's primary key). */
  referencesColumn: string;
}

/** An index reported by the source database. */
export interface SourceIndex {
  name: string;
  columns: string[];
  unique: boolean;
}

/** A single table as reported by the source database's introspection. */
export interface SourceTable {
  name: string;
  columns: SourceColumn[];
  /** Primary-key column names; empty when the table has no primary key. */
  primaryKey: string[];
  foreignKeys: SourceForeignKey[];
  indexes: SourceIndex[];
}

/** The full introspected schema of a source database. */
export interface SourceSchema {
  tables: SourceTable[];
}

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
  constructor(message: string) {
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
  constructor(message: string) {
    super(message);
    this.name = 'SourceAuthenticationError';
  }
}

// ---------------------------------------------------------------------------
// The port
// ---------------------------------------------------------------------------

/**
 * An open introspection session against a source database.
 */
export interface SourceIntrospector {
  /** Read the full schema (tables/columns/types/PKs/FKs/indexes). */
  introspect(): Promise<SourceSchema>;
  /** Release the connection. */
  close(): Promise<void>;
}

/**
 * Opens introspection sessions against a source MySQL/PostgreSQL database.
 * Implementations connect to the concrete database (a real driver in
 * production, an in-memory fake in tests).
 */
export interface SourceDbDriver {
  /**
   * Establish a connection to the database described by {@link creds}, giving
   * up after {@link timeoutMs}. Rejects with a
   * {@link SourceConnectionTimeoutError} if the connection cannot be
   * established within the deadline, or a {@link SourceAuthenticationError} if
   * the credentials are rejected.
   */
  connect(
    creds: DbCredentials,
    timeoutMs: number,
  ): Promise<SourceIntrospector>;
}
