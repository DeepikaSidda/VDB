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
import type { DataModel, DataType } from './types.js';
import { type Result } from './result.js';
/**
 * Runtime mirror of the `DataType` union. The type system constrains
 * well-formed `DataModel`s, but raw candidate models (e.g. produced by the
 * LLM) are untrusted and may carry arbitrary `dataType` strings, so I2 needs a
 * runtime membership check.
 */
export declare const SUPPORTED_DATA_TYPES: readonly DataType[];
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
export type InvariantViolation = {
    invariant: 'I1';
    message: string;
    /** The entity whose primary key is empty. */
    entity: string;
} | {
    invariant: 'I2';
    message: string;
    entity: string;
    attribute: string;
    /** The unsupported data type that was found. */
    dataType: string;
} | {
    invariant: 'I3';
    message: string;
    relationship: RelationshipRef;
    /** The invalid cardinality value that was found. */
    cardinality: string;
} | {
    invariant: 'I4';
    message: string;
    relationship: RelationshipRef;
    /**
     * The endpoint primary keys a conforming join entity must reference.
     */
    missingReferenceTo: string[];
} | {
    invariant: 'I5';
    message: string;
    entity: string;
    attribute: string;
    /** The undefined entity named by the foreign key. */
    referencedEntity: string;
} | {
    invariant: 'I6';
    message: string;
    relationship: RelationshipRef;
    /** Which endpoint(s) name an undefined entity. */
    missingEndpoint: 'source' | 'target';
    /** The undefined entity name. */
    entity: string;
};
/** I1 — every entity has a single, non-empty primary key (Req 1.2). */
export declare function checkI1(model: DataModel): InvariantViolation[];
/** I2 — every attribute has a supported data type (Req 1.4). */
export declare function checkI2(model: DataModel): InvariantViolation[];
/** I3 — every relationship has a valid cardinality (Req 1.3). */
export declare function checkI3(model: DataModel): InvariantViolation[];
/**
 * I4 — for every MANY_TO_MANY relationship there exists a join entity with
 * foreign keys to both endpoints' primary keys (Req 1.5).
 */
export declare function checkI4(model: DataModel): InvariantViolation[];
/** I5 — every foreign-key reference names a defined entity (Req 2.5, 2.6). */
export declare function checkI5(model: DataModel): InvariantViolation[];
/**
 * I6 — every relationship's source and target name a defined entity
 * (precondition for the Schema_Generator → Req 3.7).
 */
export declare function checkI6(model: DataModel): InvariantViolation[];
/**
 * Validate a single invariant by id, returning the typed violations on
 * failure following the fail-closed `Result` discipline.
 */
export declare function validateInvariant(model: DataModel, id: InvariantId): Result<void, InvariantViolation[]>;
/**
 * Validate all Data_Model invariants (I1–I6). Returns the model on success or
 * the complete, ordered list of every violation found. Aggregating all
 * violations (rather than failing on the first) gives the Modeling_Engine /
 * Refinement_Engine a full picture of what must be repaired.
 */
export declare function validateDataModel(model: DataModel): Result<DataModel, InvariantViolation[]>;
