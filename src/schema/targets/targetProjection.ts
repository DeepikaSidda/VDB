/**
 * The `TargetProjection` abstraction (design principle: "One IR, many
 * projections").
 *
 * Every deployment target the Schema_Generator supports is expressed as a
 * projection from the dialect-independent {@link DataModel} IR to a
 * {@link MigrationScript}. Adding a new target means adding a projection here,
 * not changing the core generator — the dispatch in `schemaGenerator.generate`
 * simply routes the configured target to its projection.
 *
 * - Aurora PostgreSQL and Aurora DSQL are relational projections producing SQL
 *   DDL (Req 3.x, 13.1). Both reuse the shared relational logic in
 *   `relational.ts`.
 * - DynamoDB is a non-relational projection producing a table *design* plus a
 *   report of constraints/relationships it cannot represent (Req 13.2, 13.3).
 *   It implements this base interface (its `generate` returns just the table
 *   design as a `MigrationScript`) and additionally exposes a richer `design`
 *   API that returns the unrepresented-element report alongside the script.
 */

import type { DataModel, DeploymentTargetKind, MigrationScript } from '../../model/types.js';
import type { Result } from '../../model/result.js';
import type { SchemaGenError } from './relational.js';

/**
 * A projection from the Data_Model IR to a {@link MigrationScript} for one
 * deployment target. Each projection owns its dialect-specific generation but
 * shares the IR contract and the fail-closed {@link SchemaGenError} discipline.
 */
export interface TargetProjection {
  /** The deployment target this projection emits for. */
  readonly target: DeploymentTargetKind;
  /**
   * Project the model into an ordered migration script for this target, or
   * fail closed with a {@link SchemaGenError} (emitting no DDL).
   */
  generate(model: DataModel): Result<MigrationScript, SchemaGenError>;
}

/**
 * The set of deployment targets the Schema_Generator supports. Any target
 * outside this set is the Req 13.4 unsupported-target condition. This is the
 * single source of truth for both the dispatch and the error message.
 */
export const SUPPORTED_TARGETS: readonly DeploymentTargetKind[] = [
  'POSTGRES',
  'AURORA_DSQL',
  'DYNAMODB',
];

/**
 * Whether `target` (an arbitrary, possibly out-of-union string) is one of the
 * supported deployment targets. Accepts `string` so the dispatch can defend
 * against an unsupported target value supplied at a boundary (Req 13.4).
 */
export function isSupportedTarget(
  target: string,
): target is DeploymentTargetKind {
  return (SUPPORTED_TARGETS as readonly string[]).includes(target);
}
