/**
 * Schema_Generator — target dispatch + Aurora PostgreSQL projection.
 *
 * Deterministic projection of a {@link DataModel} into an ordered
 * {@link MigrationScript}. This module is the public entry point: `generate`
 * routes the configured deployment target to its {@link TargetProjection}
 * (design principle "One IR, many projections"):
 *
 * - `POSTGRES` (primary, Req 3.x) and `AURORA_DSQL` (Req 13.1) are relational
 *   projections sharing the logic in `targets/relational.ts`.
 * - `DYNAMODB` (Req 13.2/13.3) is a non-relational table-design projection;
 *   its `generate` path returns the table design, and
 *   {@link generateDynamoDbDesign} additionally returns the report of
 *   constraints/relationships the design cannot represent.
 * - Any target outside the supported set yields an `UNSUPPORTED_TARGET` error
 *   listing the supported targets and emits no output (Req 13.4).
 *
 * The Aurora PostgreSQL projection produces clean, standard PostgreSQL DDL so
 * the Round-Trip Verifier (task 4) can parse it back into a Data_Model. The
 * `DATA_TYPE_TO_POSTGRES` mapping, `mapDataType`, and the `SchemaGenError`
 * union live in `targets/relational.ts` and are re-exported here so existing
 * importers (the Round-Trip Verifier, tests) keep their import path.
 */

import type {
  DataModel,
  DeploymentTargetKind,
  MigrationScript,
} from '../model/types.js';
import { type Result, err } from '../model/result.js';
import { generateRelational } from './targets/relational.js';
import { generateAuroraDsql } from './targets/auroraDsql.js';
import { generateDynamoDb } from './targets/dynamodb.js';
import {
  SUPPORTED_TARGETS,
  isSupportedTarget,
} from './targets/targetProjection.js';

// Re-export the shared schema-generation surface so existing importers (the
// Round-Trip Verifier and tests) continue to import it from this module.
export {
  DATA_TYPE_TO_POSTGRES,
  mapDataType,
  type SchemaGenError,
} from './targets/relational.js';
import type { SchemaGenError } from './targets/relational.js';

// Re-export the target-projection surface for callers that want the DynamoDB
// report or the projection abstraction directly.
export {
  type TargetProjection,
  SUPPORTED_TARGETS,
  isSupportedTarget,
} from './targets/targetProjection.js';
export {
  type DynamoDbDesign,
  type UnrepresentedElement,
  generateDynamoDbDesign,
} from './targets/dynamodb.js';

/**
 * Generate an ordered migration script (or table design) from a Data_Model for
 * the configured deployment `target`.
 *
 * Target routing (Req 13.4 first — an unsupported target fails closed before
 * any generation):
 * - an unsupported target returns an `UNSUPPORTED_TARGET` error naming the
 *   supported targets and emits no output (Req 13.4);
 * - `POSTGRES` → the Aurora PostgreSQL relational projection (Req 3.x);
 * - `AURORA_DSQL` → the Aurora DSQL relational projection (Req 13.1);
 * - `DYNAMODB` → the DynamoDB table-design projection (Req 13.2). Use
 *   {@link generateDynamoDbDesign} to also obtain the Req 13.3 report of
 *   unrepresented constraints/relationships.
 *
 * Every projection fails closed: on any error it returns the error and emits no
 * DDL whatsoever (Req 3.10).
 *
 * `target` is typed as `DeploymentTargetKind` for normal callers but the
 * unsupported-target check operates on it as a string, so a value supplied
 * outside the closed union at a boundary is still defended against (Req 13.4).
 */
export function generate(
  model: DataModel,
  target: DeploymentTargetKind = 'POSTGRES',
): Result<MigrationScript, SchemaGenError> {
  // Req 13.4 — reject any unsupported target before generating, emitting no
  // output and identifying the set of supported targets.
  if (!isSupportedTarget(target)) {
    return err({
      kind: 'UNSUPPORTED_TARGET',
      message:
        `Unsupported deployment target "${target}". Supported targets are: ` +
        `${SUPPORTED_TARGETS.join(', ')}.`,
      target,
      supportedTargets: [...SUPPORTED_TARGETS],
    });
  }

  switch (target) {
    case 'POSTGRES':
      return generateRelational(model, 'POSTGRES');
    case 'AURORA_DSQL':
      return generateAuroraDsql(model);
    case 'DYNAMODB':
      return generateDynamoDb(model);
    default: {
      // Exhaustiveness guard: every supported target is handled above.
      const _exhaustive: never = target;
      void _exhaustive;
      return err({
        kind: 'UNSUPPORTED_TARGET',
        message:
          `Unsupported deployment target "${String(target)}". Supported ` +
          `targets are: ${SUPPORTED_TARGETS.join(', ')}.`,
        target: String(target),
        supportedTargets: [...SUPPORTED_TARGETS],
      });
    }
  }
}
