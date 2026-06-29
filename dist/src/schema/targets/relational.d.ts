/**
 * Shared relational-DDL building blocks for relational {@link TargetProjection}s.
 *
 * Both the Aurora PostgreSQL target and the Aurora DSQL target are relational
 * SQL dialects whose generated DDL is, for the scope of this system, identical:
 * one `CREATE TABLE` per entity (with mapped column types, primary key, and
 * inline unique/not-null constraints), foreign-key constraints, one index per
 * foreign-key column, all topologically ordered so a referenced table is
 * created before any table that references it.
 *
 * This module holds that shared logic so the PostgreSQL and DSQL projections
 * are the *same* deterministic relational projection differing only in the
 * `MigrationScript.target` tag. It also owns the {@link SchemaGenError} union,
 * the fixed `DataType -> PostgreSQL` mapping, and `mapDataType`, all of which
 * the `schemaGenerator` module re-exports for backward compatibility (the
 * Round-Trip Verifier and existing tests import them from there).
 *
 * Keeping these helpers in a dependency-free leaf module (it imports only the
 * IR types and `Result`) means every projection can reuse them without any
 * import cycle through `schemaGenerator`.
 */
import type { Attribute, DataModel, DataType, DeploymentTargetKind, Entity, MigrationScript } from '../../model/types.js';
import { type Result } from '../../model/result.js';
/**
 * The fixed Data_Model `DataType` -> Aurora PostgreSQL type mapping from the
 * design's "DataType -> Aurora PostgreSQL mapping" section. Aurora DSQL is
 * PostgreSQL-compatible, so the same table serves both relational targets. An
 * attribute whose `dataType` is not a key of this table triggers Req 3.8.
 */
export declare const DATA_TYPE_TO_POSTGRES: Record<DataType, string>;
/**
 * Map a Data_Model {@link DataType} to its Aurora PostgreSQL type string.
 *
 * Accepts a plain `string` (not just the `DataType` union) so callers handling
 * untrusted/raw models can detect an unmappable type: a `string` that is not a
 * supported `DataType` returns `undefined` (the Req 3.8 condition). For a
 * well-formed model every attribute's type is a `DataType` and this always
 * returns the mapped string.
 */
export declare function mapDataType(dataType: string): string | undefined;
/**
 * The error conditions schema generation can fail with. Following the
 * fail-closed discipline, any of these means no DDL is emitted (Req 3.10).
 */
export type SchemaGenError = {
    kind: 'UNDEFINED_ENTITY';
    message: string;
    relationship: {
        source: string;
        target: string;
    };
    /** The undefined entity named by the relationship. */
    entity: string;
} | {
    kind: 'UNMAPPABLE_TYPE';
    message: string;
    entity: string;
    attribute: string;
    dataType: string;
} | {
    kind: 'CYCLIC_DEPENDENCY';
    message: string;
    /** The entities involved in the cycle. */
    entities: string[];
} | {
    kind: 'UNSUPPORTED_TARGET';
    message: string;
    /** The unsupported target that was requested. */
    target: string;
    /** The set of targets the Schema_Generator does support. */
    supportedTargets: DeploymentTargetKind[];
};
/**
 * Quote a SQL identifier with double quotes so names round-trip faithfully
 * (preserving case and avoiding keyword collisions). Embedded double quotes
 * are escaped per the SQL standard by doubling.
 */
export declare function quoteIdent(name: string): string;
/** A foreign-key column paired with the reference it carries. */
export type ForeignKeyColumn = {
    attribute: Attribute;
    references: {
        entity: string;
        attribute: string;
    };
};
/** Extract this entity's foreign-key columns, in attribute order. */
export declare function foreignKeyColumns(entity: Entity): ForeignKeyColumn[];
/**
 * Req 3.7 — referential closure. Every `Relationship.source`/`target` (I6) and
 * every `FOREIGN_KEY.references.entity` (I5) must name an entity defined in the
 * model. Returns the first violation found, or `undefined` if all references
 * resolve.
 */
export declare function findUndefinedEntity(model: DataModel): SchemaGenError | undefined;
/**
 * Req 3.8 — every attribute's data type must map to a PostgreSQL type. Returns
 * the first attribute whose type is unmappable (`mapDataType` returns
 * `undefined`), or `undefined` if all types map.
 */
export declare function findUnmappableType(model: DataModel): SchemaGenError | undefined;
/**
 * Req 3.6 / 3.9 — topologically order the entities so every referenced table
 * is created before any table that references it.
 *
 * The dependency graph is built from foreign-key references: an entity with an
 * FK to another entity depends on (must be created after) the referenced
 * entity. Self-referencing FKs are excluded — a table can be created before its
 * own self-FK is added via `ALTER TABLE`, so a self-loop is never an
 * unorderable cycle.
 *
 * Uses Kahn's algorithm, placing all currently-ready entities in original model
 * order each pass, so the output ordering is deterministic. If a non-self cycle
 * leaves entities unplaceable, returns a `CYCLIC_DEPENDENCY` error naming the
 * entities involved (Req 3.9).
 *
 * Precondition: all FK references resolve (checked by `findUndefinedEntity`).
 */
export declare function topologicallyOrderEntities(model: DataModel): Result<Entity[], SchemaGenError>;
/**
 * Generate an ordered relational migration script from a Data_Model for a
 * relational `target` (Aurora PostgreSQL or Aurora DSQL — same SQL).
 *
 * Validation happens first and fails closed: if any error condition is
 * detected, the function returns the error and emits no DDL whatsoever
 * (Req 3.10). The checks, in order, are undefined entity references
 * (Req 3.7 → `UNDEFINED_ENTITY`), unmappable data types
 * (Req 3.8 → `UNMAPPABLE_TYPE`), and unorderable cyclic foreign-key
 * dependencies (Req 3.9 → `CYCLIC_DEPENDENCY`).
 *
 * On success, `CREATE TABLE` statements are emitted in topological order so
 * every referenced table is created before any table that references it
 * (Req 3.6), followed by the `ADD_FK` and `CREATE_INDEX` statements. The
 * emitted script carries the supplied `target` tag.
 */
export declare function generateRelational(model: DataModel, target: DeploymentTargetKind): Result<MigrationScript, SchemaGenError>;
