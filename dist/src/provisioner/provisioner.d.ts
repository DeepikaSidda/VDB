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
import type { DeployResult, DeploymentTarget, MigrationScript } from '../model/types.js';
import { type Clock, type DbDriver } from './driver.js';
/**
 * The Provisioner contract from the design.
 */
export interface Provisioner {
    apply(script: MigrationScript, target: DeploymentTarget): Promise<DeployResult>;
}
/**
 * Dependency-injected implementation of the {@link Provisioner}. Construct it
 * with a {@link DbDriver} (in-memory fake in tests, real `pg` adapter in
 * production) and optionally a {@link Clock} for deterministic timeout logic.
 */
export declare class TransactionalProvisioner implements Provisioner {
    private readonly driver;
    private readonly clock;
    constructor(driver: DbDriver, clock?: Clock);
    apply(script: MigrationScript, target: DeploymentTarget): Promise<DeployResult>;
    /**
     * Enforce the 300s apply ceiling (Req 4.1). Throwing here routes through the
     * apply-phase catch, which rolls back and reports a `MIGRATION` failure.
     */
    private assertWithinCeiling;
}
