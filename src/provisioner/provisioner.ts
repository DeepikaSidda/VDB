/**
 * Provisioner / Migration Runner (Requirement 4).
 *
 * Applies a verified {@link MigrationScript} to a live Aurora PostgreSQL
 * Deployment_Target atomically:
 *
 * - Connect within 30s, else fail with a `CONNECTIVITY` error (Req 4.5).
 * - Apply the WHOLE script inside a single transaction; commit only if every
 *   statement succeeds, within the 300s apply ceiling → status `deployed`
 *   (Req 4.1, 4.2).
 * - On any statement failure, roll back so the target is restored to its
 *   pre-migration state → status `failed` with a reason and cause `MIGRATION`
 *   (Req 4.3, 4.4).
 * - Route Aurora PostgreSQL jobs to an Aurora PostgreSQL target (Req 4.6).
 *
 * The runtime guarantee that a failed migration rolls back completely is the
 * basis for Property 19.
 *
 * To stay unit-testable without a live AWS connection, the Provisioner depends
 * only on the injected {@link DbDriver} port and an injectable {@link Clock}
 * (see ./driver.ts). Property tests supply the transactional
 * {@link InMemoryDriver}; integration tests can supply a real `pg`-backed
 * driver.
 */

import type {
  DeployResult,
  DeploymentTarget,
  MigrationScript,
} from '../model/types.js';
import {
  type Clock,
  type DbConnection,
  type DbDriver,
  APPLY_CEILING_MS,
  CONNECT_TIMEOUT_MS,
  ConnectivityError,
  systemClock,
} from './driver.js';

/**
 * The Provisioner contract from the design.
 */
export interface Provisioner {
  apply(
    script: MigrationScript,
    target: DeploymentTarget,
  ): Promise<DeployResult>;
}

/**
 * Dependency-injected implementation of the {@link Provisioner}. Construct it
 * with a {@link DbDriver} (in-memory fake in tests, real `pg` adapter in
 * production) and optionally a {@link Clock} for deterministic timeout logic.
 */
export class TransactionalProvisioner implements Provisioner {
  private readonly driver: DbDriver;
  private readonly clock: Clock;

  constructor(driver: DbDriver, clock: Clock = systemClock) {
    this.driver = driver;
    this.clock = clock;
  }

  async apply(
    script: MigrationScript,
    target: DeploymentTarget,
  ): Promise<DeployResult> {
    // Req 4.6 — route the job to a matching target. The script declares the
    // target dialect it was generated for; applying it to a different kind of
    // target would be a misroute, so we fail closed before touching anything.
    if (script.target !== target.kind) {
      return {
        status: 'failed',
        reason:
          `target mismatch: migration was generated for ${script.target} ` +
          `but the configured Deployment_Target is ${target.kind}`,
        cause: 'MIGRATION',
      };
    }

    // --- Connect phase (Req 4.5) --------------------------------------------
    const connectStart = this.clock.now();
    let connection: DbConnection;
    try {
      connection = await this.driver.connect(target, CONNECT_TIMEOUT_MS);
    } catch (error) {
      return {
        status: 'failed',
        reason: `could not connect to the Deployment_Target: ${messageOf(error)}`,
        cause: 'CONNECTIVITY',
      };
    }

    // Backstop deadline check: even if the driver returned, treat a connect
    // that took longer than the 30s window as a connectivity failure.
    if (this.clock.now() - connectStart > CONNECT_TIMEOUT_MS) {
      await safeClose(connection);
      return {
        status: 'failed',
        reason: `connection exceeded the ${CONNECT_TIMEOUT_MS}ms connect window`,
        cause: 'CONNECTIVITY',
      };
    }

    // --- Apply phase: single transaction (Req 4.1, 4.2, 4.3, 4.4) -----------
    const applyStart = this.clock.now();
    try {
      await connection.begin();

      for (let i = 0; i < script.statements.length; i++) {
        this.assertWithinCeiling(applyStart);
        await connection.exec(script.statements[i]!);
      }

      // Final ceiling check before committing the whole script.
      this.assertWithinCeiling(applyStart);
      await connection.commit();
      await safeClose(connection);
      return { status: 'deployed' };
    } catch (error) {
      // Any failure (a failed statement, or the apply ceiling being exceeded)
      // rolls back so the target is restored to its pre-migration state.
      await safeRollback(connection);
      await safeClose(connection);
      return {
        status: 'failed',
        reason: `migration failed and was rolled back: ${messageOf(error)}`,
        cause: 'MIGRATION',
      };
    }
  }

  /**
   * Enforce the 300s apply ceiling (Req 4.1). Throwing here routes through the
   * apply-phase catch, which rolls back and reports a `MIGRATION` failure.
   */
  private assertWithinCeiling(applyStart: number): void {
    if (this.clock.now() - applyStart > APPLY_CEILING_MS) {
      throw new Error(
        `migration exceeded the ${APPLY_CEILING_MS}ms apply ceiling`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function messageOf(error: unknown): string {
  if (error instanceof ConnectivityError || error instanceof Error) {
    return error.message;
  }
  return String(error);
}

async function safeRollback(connection: DbConnection): Promise<void> {
  try {
    await connection.rollback();
  } catch {
    // Best-effort: a rollback failure must not mask the original error.
  }
}

async function safeClose(connection: DbConnection): Promise<void> {
  try {
    await connection.close();
  } catch {
    // Best-effort cleanup.
  }
}
