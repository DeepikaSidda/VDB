/**
 * Integration-style tests for live migration behavior (task 6.3).
 *
 * **Validates: Requirements 4.1, 4.2, 4.3, 4.4, 4.5, 4.6**
 *
 * There is no live Aurora PostgreSQL instance in this environment, so these
 * tests exercise the same Provisioner code paths against the transactional
 * {@link InMemoryDriver} fake. The REAL-AURORA variant of each test would be
 * identical except it would construct the `pg`-backed driver instead:
 *
 * ```ts
 * import { PgDriver } from '../../src/provisioner/pgDriver.js';
 * const driver = new PgDriver(); // wired to a live Aurora PostgreSQL endpoint
 * const provisioner = new TransactionalProvisioner(driver); // real systemClock
 * ```
 *
 * (See src/provisioner/pgDriver.ts — currently a marked placeholder.) Because
 * the Provisioner depends only on the {@link DbDriver} port and an injectable
 * {@link Clock}, swapping the driver is the only change needed; the assertions
 * about status, cause, and rollback hold for both.
 *
 * Determinism: a shared {@link MutableClock} is handed to both the fake and the
 * Provisioner so the 30s connect deadline (Req 4.5) and 300s apply ceiling
 * (Req 4.1) are exercised without any real elapsed time.
 */

import { describe, it, expect } from 'vitest';
import type {
  DdlStatement,
  DeploymentTarget,
  MigrationScript,
} from '../../src/model/types.js';
import { TransactionalProvisioner } from '../../src/provisioner/provisioner.js';
import {
  InMemoryDriver,
  MutableClock,
} from '../../src/provisioner/inMemoryDriver.js';
import {
  APPLY_CEILING_MS,
  CONNECT_TIMEOUT_MS,
} from '../../src/provisioner/driver.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const POSTGRES_TARGET: DeploymentTarget = {
  kind: 'POSTGRES',
  connection: {
    host: 'aurora.example.aws',
    port: 5432,
    database: 'appdb',
    user: 'app',
    password: 'secret',
  },
};

const SAMPLE_STATEMENTS: DdlStatement[] = [
  { sql: 'CREATE TABLE "User" ("id" uuid, PRIMARY KEY ("id"))', kind: 'CREATE_TABLE' },
  {
    sql: 'CREATE TABLE "Post" ("id" uuid, "authorId" uuid, PRIMARY KEY ("id"))',
    kind: 'CREATE_TABLE',
  },
  {
    sql: 'ALTER TABLE "Post" ADD FOREIGN KEY ("authorId") REFERENCES "User" ("id")',
    kind: 'ADD_FK',
  },
  { sql: 'CREATE INDEX ON "Post" ("authorId")', kind: 'CREATE_INDEX' },
];

function postgresScript(statements: DdlStatement[]): MigrationScript {
  return { target: 'POSTGRES', statements };
}

// ---------------------------------------------------------------------------
// Success path (Req 4.1, 4.2, 4.6)
// ---------------------------------------------------------------------------

describe('live migration — success path (Req 4.1, 4.2, 4.6)', () => {
  it('applies a full script within the apply ceiling and records status "deployed"', async () => {
    const clock = new MutableClock();
    // Each statement takes a modest, in-budget amount of simulated time.
    const driver = new InMemoryDriver({ clock, execDurationMs: 1_000 });
    const provisioner = new TransactionalProvisioner(driver, clock);

    const result = await provisioner.apply(
      postgresScript(SAMPLE_STATEMENTS),
      POSTGRES_TARGET,
    );

    expect(result).toEqual({ status: 'deployed' });
    // Every statement was committed durably (all-or-nothing → all).
    expect(driver.appliedStatements()).toEqual(SAMPLE_STATEMENTS);
    // Well within the 300s apply ceiling.
    expect(clock.now()).toBeLessThanOrEqual(APPLY_CEILING_MS);
  });
});

// ---------------------------------------------------------------------------
// Statement failure → rollback (Req 4.3, 4.4)
// ---------------------------------------------------------------------------

describe('live migration — statement failure (Req 4.3, 4.4)', () => {
  it('records "failed" with a reason and cause MIGRATION, rolling back completely', async () => {
    const clock = new MutableClock();
    const driver = new InMemoryDriver({
      clock,
      // Fail on the third statement (the FK), mid-migration.
      failOnStatement: (_stmt, index) => index === 2,
    });
    const provisioner = new TransactionalProvisioner(driver, clock);

    const result = await provisioner.apply(
      postgresScript(SAMPLE_STATEMENTS),
      POSTGRES_TARGET,
    );

    expect(result.status).toBe('failed');
    if (result.status === 'failed') {
      expect(result.cause).toBe('MIGRATION');
      expect(result.reason).toMatch(/rolled back/i);
    }
    // Full rollback: the target is restored to its empty pre-migration state.
    expect(driver.appliedStatements()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Apply ceiling exceeded → rollback (Req 4.1)
// ---------------------------------------------------------------------------

describe('live migration — apply ceiling exceeded (Req 4.1)', () => {
  it('fails with cause MIGRATION and rolls back when the 300s ceiling is exceeded', async () => {
    const clock = new MutableClock();
    // Each statement burns more than half the ceiling, so the cumulative
    // elapsed time crosses APPLY_CEILING_MS partway through the script.
    const driver = new InMemoryDriver({
      clock,
      execDurationMs: APPLY_CEILING_MS / 2 + 1,
    });
    const provisioner = new TransactionalProvisioner(driver, clock);

    const result = await provisioner.apply(
      postgresScript(SAMPLE_STATEMENTS),
      POSTGRES_TARGET,
    );

    expect(result.status).toBe('failed');
    if (result.status === 'failed') {
      expect(result.cause).toBe('MIGRATION');
    }
    // Nothing was committed — the ceiling breach rolled the transaction back.
    expect(driver.appliedStatements()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Connectivity failure (Req 4.5)
// ---------------------------------------------------------------------------

describe('live migration — connectivity failure (Req 4.5)', () => {
  it('records "failed" with cause CONNECTIVITY when the target is unreachable', async () => {
    const clock = new MutableClock();
    const driver = new InMemoryDriver({ clock, reachable: false });
    const provisioner = new TransactionalProvisioner(driver, clock);

    const result = await provisioner.apply(
      postgresScript(SAMPLE_STATEMENTS),
      POSTGRES_TARGET,
    );

    expect(result.status).toBe('failed');
    if (result.status === 'failed') {
      expect(result.cause).toBe('CONNECTIVITY');
      expect(typeof result.reason).toBe('string');
    }
    // Never entered a transaction, so nothing is committed.
    expect(driver.appliedStatements()).toEqual([]);
  });

  it('records "failed" with cause CONNECTIVITY when the connect deadline is exceeded', async () => {
    const clock = new MutableClock();
    // A connection attempt that takes longer than the 30s connect window.
    const driver = new InMemoryDriver({
      clock,
      connectDurationMs: CONNECT_TIMEOUT_MS + 1,
    });
    const provisioner = new TransactionalProvisioner(driver, clock);

    const result = await provisioner.apply(
      postgresScript(SAMPLE_STATEMENTS),
      POSTGRES_TARGET,
    );

    expect(result.status).toBe('failed');
    if (result.status === 'failed') {
      expect(result.cause).toBe('CONNECTIVITY');
    }
    expect(driver.appliedStatements()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Target-mismatch routing (Req 4.6)
// ---------------------------------------------------------------------------

describe('live migration — target routing (Req 4.6)', () => {
  it('fails closed with cause MIGRATION when the script target does not match the deployment target', async () => {
    const clock = new MutableClock();
    // reachable:false would yield CONNECTIVITY *if* the provisioner tried to
    // connect. Asserting cause MIGRATION therefore proves the routing guard
    // failed closed BEFORE any connection attempt.
    const driver = new InMemoryDriver({ clock, reachable: false });
    const provisioner = new TransactionalProvisioner(driver, clock);

    // Script generated for AURORA_DSQL but routed at a POSTGRES target.
    const misroutedScript: MigrationScript = {
      target: 'AURORA_DSQL',
      statements: SAMPLE_STATEMENTS,
    };

    const result = await provisioner.apply(misroutedScript, POSTGRES_TARGET);

    expect(result.status).toBe('failed');
    if (result.status === 'failed') {
      expect(result.cause).toBe('MIGRATION');
      expect(result.reason).toMatch(/target mismatch/i);
    }
    // No connection, no transaction, nothing committed.
    expect(driver.appliedStatements()).toEqual([]);
  });

  it('routes a matching POSTGRES script to the POSTGRES target and deploys', async () => {
    const clock = new MutableClock();
    const driver = new InMemoryDriver({ clock });
    const provisioner = new TransactionalProvisioner(driver, clock);

    const result = await provisioner.apply(
      postgresScript(SAMPLE_STATEMENTS),
      POSTGRES_TARGET,
    );

    expect(result).toEqual({ status: 'deployed' });
    expect(driver.appliedStatements()).toEqual(SAMPLE_STATEMENTS);
  });
});
