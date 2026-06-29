/**
 * Property-based test for the Provisioner (task 6.2).
 *
 * Feature: ai-database-architect, Property 19: Failed migration rolls back completely
 *
 * **Validates: Requirements 4.4**
 *
 * Property text (design): *For any* migration script that fails at some
 * statement (tested against a transactional store/fake and corroborated by
 * integration tests), the resulting schema state equals the schema state prior
 * to the migration attempt (no partial schema change remains).
 *
 * Run against the transactional in-memory fake ({@link InMemoryDriver}): a
 * rollback discards every statement executed since `begin`, so a failed
 * migration must leave the durable committed state exactly as it was before the
 * attempt (here, empty). The complementary success case asserts that when no
 * statement fails the whole script commits.
 */

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
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

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

const ddlKindArb = fc.constantFrom<DdlStatement['kind']>(
  'CREATE_TABLE',
  'ADD_FK',
  'CREATE_INDEX',
);

const ddlStatementArb: fc.Arbitrary<DdlStatement> = fc.record({
  sql: fc.string(),
  kind: ddlKindArb,
});

/** A non-empty, ordered list of DDL statements (a migration script body). */
const statementsArb = fc.array(ddlStatementArb, { minLength: 1, maxLength: 25 });

/**
 * A migration script plus an optional failing-statement index. `failAt === null`
 * models a fully successful migration; otherwise the statement at that index is
 * configured to fail, aborting the transaction.
 */
const scenarioArb = statementsArb.chain((statements) =>
  fc.record({
    statements: fc.constant(statements),
    failAt: fc.option(fc.integer({ min: 0, max: statements.length - 1 }), {
      nil: null,
    }),
  }),
);

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const POSTGRES_TARGET: DeploymentTarget = {
  kind: 'POSTGRES',
  connection: {
    host: 'localhost',
    port: 5432,
    database: 'appdb',
    user: 'app',
    password: 'secret',
  },
};

function postgresScript(statements: DdlStatement[]): MigrationScript {
  return { target: 'POSTGRES', statements };
}

// ---------------------------------------------------------------------------
// Property 19
// ---------------------------------------------------------------------------

describe('Property 19: Failed migration rolls back completely (Req 4.4)', () => {
  it('post-apply committed state equals the pre-apply state whenever any statement fails', async () => {
    await fc.assert(
      fc.asyncProperty(scenarioArb, async ({ statements, failAt }) => {
        const clock = new MutableClock();
        const driver = new InMemoryDriver({
          clock,
          failOnStatement:
            failAt === null ? undefined : (_stmt, index) => index === failAt,
        });
        const provisioner = new TransactionalProvisioner(driver, clock);

        // Pre-migration durable state (a fresh driver has applied nothing).
        const before = driver.appliedStatements();
        expect(before).toHaveLength(0);

        const result = await provisioner.apply(
          postgresScript(statements),
          POSTGRES_TARGET,
        );

        if (failAt === null) {
          // No statement fails: the whole script commits atomically.
          expect(result.status).toBe('deployed');
          expect(driver.appliedStatements()).toEqual(statements);
        } else {
          // A statement fails: the transaction rolls back and the durable
          // state is restored to exactly its pre-migration value (empty).
          expect(result.status).toBe('failed');
          if (result.status === 'failed') {
            expect(result.cause).toBe('MIGRATION');
            expect(typeof result.reason).toBe('string');
          }
          // The key property: complete rollback leaves NO committed statements.
          expect(driver.appliedStatements()).toEqual(before);
          expect(driver.appliedStatements()).toHaveLength(0);
        }
      }),
      { numRuns: 100 },
    );
  });
});
