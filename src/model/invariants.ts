/**
 * Data_Model invariant validators (I1–I6).
 *
 * These invariants must hold for any Data_Model handed to the
 * Schema_Generator. They are enforced by the Modeling_Engine /
 * Refinement_Engine and are the basis for several correctness properties.
 * See the design's "Data_Model Invariants" subsection.
 *
 * - I1 — Single PK per entity: every `Entity.primaryKey` is non-empty
 *   (Req 1.2). A surrogate key is synthesized when none is inferred (Req 2.6).
 * - I2 — Typed attributes: every `Attribute.dataType` is a member of the
 *   supported `DataType` set (Req 1.4).
 * - I3 — Valid cardinality: every `Relationship.cardinality` is one of
 *   ONE_TO_ONE / ONE_TO_MANY / MANY_TO_MANY (Req 1.3).
 * - I4 — M:N join entities: for every `MANY_TO_MANY` relationship there exists
 *   a join entity with foreign keys to both endpoints' primary keys (Req 1.5).
 * - I5 — FK targets exist: every `FOREIGN_KEY.references.entity` names an
 *   entity in the model (Req 2.5, 2.6).
 * - I6 — Referential closure for relationships: every
 *   `Relationship.source`/`target` names a defined entity (precondition for
 *   the Schema_Generator → Req 3.7).
 *
 * Every validator follows the shared fail-closed `Result<T, E>` discipline:
 * a passing model yields `ok`, a violating model yields a list of typed
 * `InvariantViolation`s that identify the offending element.
 */

import type {
  Attribute,
  DataModel,
  DataType,
  Entity,
  Relationship,
} from './types.js';
import { type Result, ok, err } from './result.js';

// ---------------------------------------------------------------------------
// Supported data types (runtime mirror of the `DataType` union)
// ---------------------------------------------------------------------------

/**
 * Runtime mirror of the `DataType` union. The type system constrains
 * well-formed `DataModel`s, but raw candidate models (e.g. produced by the
 * LLM) are untrusted and may carry arbitrary `dataType` strings, so I2 needs a
 * runtime membership check.
 */
export const SUPPORTED_DATA_TYPES: readonly DataType[] = [
  'UUID', 'TEXT', 'VARCHAR', 'INTEGER', 'BIGINT',
  'NUMERIC', 'BOOLEAN', 'DATE', 'TIMESTAMP', 'JSON',
];

const ALLOWED_CARDINALITIES: readonly Relationship['cardinality'][] = [
  'ONE_TO_ONE', 'ONE_TO_MANY', 'MANY_TO_MANY',
];

// ---------------------------------------------------------------------------
// Typed invariant errors
// ---------------------------------------------------------------------------

/** The identifier of each Data_Model invariant. */
export type InvariantId = 'I1' | 'I2' | 'I3' | 'I4' | 'I5' | 'I6';

/** A reference to a relationship by its endpoints, for error reporting. */
export type RelationshipRef = {
  source: string;
  target: string;
  cardinality?: string;
};

/**
 * A single invariant violation. Discriminated on `invariant`; each variant
 * carries enough context to identify the offending element.
 */
export type InvariantViolation =
  | {
      invariant: 'I1';
      message: string;
      /** The entity whose primary key is empty. */
      entity: string;
    }
  | {
      invariant: 'I2';
      message: string;
      entity: string;
      attribute: string;
      /** The unsupported data type that was found. */
      dataType: string;
    }
  | {
      invariant: 'I3';
      message: string;
      relationship: RelationshipRef;
      /** The invalid cardinality value that was found. */
      cardinality: string;
    }
  | {
      invariant: 'I4';
      message: string;
      relationship: RelationshipRef;
      /**
       * The endpoint primary keys a conforming join entity must reference.
       */
      missingReferenceTo: string[];
    }
  | {
      invariant: 'I5';
      message: string;
      entity: string;
      attribute: string;
      /** The undefined entity named by the foreign key. */
      referencedEntity: string;
    }
  | {
      invariant: 'I6';
      message: string;
      relationship: RelationshipRef;
      /** Which endpoint(s) name an undefined entity. */
      missingEndpoint: 'source' | 'target';
      /** The undefined entity name. */
      entity: string;
    };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function entityNameSet(model: DataModel): Set<string> {
  return new Set(model.entities.map((e) => e.name));
}

function entityByName(model: DataModel): Map<string, Entity> {
  return new Map(model.entities.map((e) => [e.name, e]));
}

function foreignKeysOf(entity: Entity): {
  attribute: Attribute;
  references: { entity: string; attribute: string };
}[] {
  const fks: {
    attribute: Attribute;
    references: { entity: string; attribute: string };
  }[] = [];
  for (const attribute of entity.attributes) {
    for (const constraint of attribute.constraints) {
      if (constraint.kind === 'FOREIGN_KEY') {
        fks.push({ attribute, references: constraint.references });
      }
    }
  }
  return fks;
}

/**
 * Does `entity` carry a foreign key referencing the primary key of
 * `targetName`? "Primary key" means the referenced attribute is a member of
 * the target entity's `primaryKey`.
 */
function referencesPrimaryKeyOf(
  entity: Entity,
  targetName: string,
  target: Entity | undefined,
): boolean {
  const pk = new Set(target?.primaryKey ?? []);
  return foreignKeysOf(entity).some(
    (fk) =>
      fk.references.entity === targetName &&
      // When the target entity is known, require the referenced attribute to
      // be part of its primary key; otherwise accept the named reference.
      (target === undefined || pk.has(fk.references.attribute)),
  );
}

// ---------------------------------------------------------------------------
// Individual invariant checks (each returns the violations it found)
// ---------------------------------------------------------------------------

/** I1 — every entity has a single, non-empty primary key (Req 1.2). */
export function checkI1(model: DataModel): InvariantViolation[] {
  const violations: InvariantViolation[] = [];
  for (const entity of model.entities) {
    if (!Array.isArray(entity.primaryKey) || entity.primaryKey.length === 0) {
      violations.push({
        invariant: 'I1',
        message: `Entity "${entity.name}" must have a non-empty primary key.`,
        entity: entity.name,
      });
    }
  }
  return violations;
}

/** I2 — every attribute has a supported data type (Req 1.4). */
export function checkI2(model: DataModel): InvariantViolation[] {
  const supported = new Set<string>(SUPPORTED_DATA_TYPES);
  const violations: InvariantViolation[] = [];
  for (const entity of model.entities) {
    for (const attribute of entity.attributes) {
      if (!supported.has(attribute.dataType as string)) {
        violations.push({
          invariant: 'I2',
          message: `Attribute "${entity.name}.${attribute.name}" has unsupported data type "${String(
            attribute.dataType,
          )}".`,
          entity: entity.name,
          attribute: attribute.name,
          dataType: String(attribute.dataType),
        });
      }
    }
  }
  return violations;
}

/** I3 — every relationship has a valid cardinality (Req 1.3). */
export function checkI3(model: DataModel): InvariantViolation[] {
  const allowed = new Set<string>(ALLOWED_CARDINALITIES);
  const violations: InvariantViolation[] = [];
  for (const rel of model.relationships) {
    if (!allowed.has(rel.cardinality as string)) {
      violations.push({
        invariant: 'I3',
        message: `Relationship "${rel.source}" -> "${rel.target}" has invalid cardinality "${String(
          rel.cardinality,
        )}".`,
        relationship: { source: rel.source, target: rel.target },
        cardinality: String(rel.cardinality),
      });
    }
  }
  return violations;
}

/**
 * I4 — for every MANY_TO_MANY relationship there exists a join entity with
 * foreign keys to both endpoints' primary keys (Req 1.5).
 */
export function checkI4(model: DataModel): InvariantViolation[] {
  const byName = entityByName(model);
  const violations: InvariantViolation[] = [];
  for (const rel of model.relationships) {
    if (rel.cardinality !== 'MANY_TO_MANY') {
      continue;
    }
    const source = byName.get(rel.source);
    const target = byName.get(rel.target);
    const hasJoinEntity = model.entities.some(
      (entity) =>
        entity.isJoinEntity &&
        referencesPrimaryKeyOf(entity, rel.source, source) &&
        referencesPrimaryKeyOf(entity, rel.target, target),
    );
    if (!hasJoinEntity) {
      violations.push({
        invariant: 'I4',
        message: `Many-to-many relationship "${rel.source}" <-> "${rel.target}" has no join entity referencing both endpoints' primary keys.`,
        relationship: {
          source: rel.source,
          target: rel.target,
          cardinality: rel.cardinality,
        },
        missingReferenceTo: [rel.source, rel.target],
      });
    }
  }
  return violations;
}

/** I5 — every foreign-key reference names a defined entity (Req 2.5, 2.6). */
export function checkI5(model: DataModel): InvariantViolation[] {
  const names = entityNameSet(model);
  const violations: InvariantViolation[] = [];
  for (const entity of model.entities) {
    for (const fk of foreignKeysOf(entity)) {
      if (!names.has(fk.references.entity)) {
        violations.push({
          invariant: 'I5',
          message: `Foreign key "${entity.name}.${fk.attribute.name}" references undefined entity "${fk.references.entity}".`,
          entity: entity.name,
          attribute: fk.attribute.name,
          referencedEntity: fk.references.entity,
        });
      }
    }
  }
  return violations;
}

/**
 * I6 — every relationship's source and target name a defined entity
 * (precondition for the Schema_Generator → Req 3.7).
 */
export function checkI6(model: DataModel): InvariantViolation[] {
  const names = entityNameSet(model);
  const violations: InvariantViolation[] = [];
  for (const rel of model.relationships) {
    if (!names.has(rel.source)) {
      violations.push({
        invariant: 'I6',
        message: `Relationship source "${rel.source}" names an undefined entity.`,
        relationship: { source: rel.source, target: rel.target },
        missingEndpoint: 'source',
        entity: rel.source,
      });
    }
    if (!names.has(rel.target)) {
      violations.push({
        invariant: 'I6',
        message: `Relationship target "${rel.target}" names an undefined entity.`,
        relationship: { source: rel.source, target: rel.target },
        missingEndpoint: 'target',
        entity: rel.target,
      });
    }
  }
  return violations;
}

// ---------------------------------------------------------------------------
// Result-returning validators
// ---------------------------------------------------------------------------

const CHECKS: Record<InvariantId, (model: DataModel) => InvariantViolation[]> = {
  I1: checkI1,
  I2: checkI2,
  I3: checkI3,
  I4: checkI4,
  I5: checkI5,
  I6: checkI6,
};

/**
 * Validate a single invariant by id, returning the typed violations on
 * failure following the fail-closed `Result` discipline.
 */
export function validateInvariant(
  model: DataModel,
  id: InvariantId,
): Result<void, InvariantViolation[]> {
  const violations = CHECKS[id](model);
  return violations.length === 0 ? ok(undefined) : err(violations);
}

/**
 * Validate all Data_Model invariants (I1–I6). Returns the model on success or
 * the complete, ordered list of every violation found. Aggregating all
 * violations (rather than failing on the first) gives the Modeling_Engine /
 * Refinement_Engine a full picture of what must be repaired.
 */
export function validateDataModel(
  model: DataModel,
): Result<DataModel, InvariantViolation[]> {
  const violations: InvariantViolation[] = [
    ...checkI1(model),
    ...checkI2(model),
    ...checkI3(model),
    ...checkI4(model),
    ...checkI5(model),
    ...checkI6(model),
  ];
  return violations.length === 0 ? ok(model) : err(violations);
}
