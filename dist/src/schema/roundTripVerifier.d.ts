/**
 * Round-Trip Verifier — DDL → Data_Model parse (task 4.1) and the deploy-gate
 * verification surface (task 4.2, stubbed here).
 *
 * Guards Requirement 12: the generated DDL is parsed back into a Data_Model and
 * structurally compared to the source before deploy. If anything was added,
 * lost, or altered, the job fails closed rather than deploying a lossy schema
 * (the VERIFYING → DEPLOYING gate in the orchestrator).
 *
 * This module implements ONLY the parse direction (`parseDDL`). The structural
 * comparison + fail-closed gate (`verify`) is task 4.2 — its interface/types
 * are defined here and `verify` is a clearly-marked stub.
 *
 * ## Parser approach (chosen: focused, dependency-free parser — option (b))
 *
 * The design suggests a general PostgreSQL grammar parser (e.g.
 * `pgsql-ast-parser`). We instead implement a focused parser that understands
 * *exactly* the small, fixed set of DDL shapes the Schema_Generator emits.
 * Rationale: we own the generator, so the grammar is tiny and stable, and a
 * dependency-free parser keeps the round-trip deterministic and the build lean
 * for the hackathon slice. The three shapes (mirroring `schemaGenerator.ts`):
 *
 *   CREATE TABLE "Name" (
 *     "col" <pgtype> [NOT NULL] [UNIQUE],
 *     ...,
 *     PRIMARY KEY ("a", "b")
 *   );
 *
 *   ALTER TABLE "X" ADD CONSTRAINT "fk_..." FOREIGN KEY ("col")
 *     REFERENCES "Y" ("id");
 *
 *   CREATE INDEX "idx_..." ON "X" ("col");
 *
 * Identifiers are double-quoted (embedded `"` escaped by doubling). PG types are
 * mapped back to `DataType` via the inverse of `DATA_TYPE_TO_POSTGRES` (reused
 * from the Schema_Generator so the two directions can never drift).
 *
 * ## Relationship-derivation convention (CRITICAL — coordinated with task 4.2)
 *
 * Cardinality (`ONE_TO_ONE | ONE_TO_MANY | MANY_TO_MANY`) is NOT expressible in
 * DDL alone, so it cannot be recovered from the migration script. To keep the
 * round-trip faithful (Property 16 compares relationship source/target/
 * cardinality), `parseDDL` and `verify` (task 4.2) MUST use one consistent
 * convention to derive a *comparable* relationship set from foreign keys:
 *
 *   - A relationship edge is derived from each FOREIGN_KEY: a directed edge from
 *     the FK-holding (dependent) entity to the referenced entity. This matches
 *     the generator's FK direction (see `constraints.ts`: for ordinary
 *     relationships the SOURCE entity is the dependent and holds the FK to the
 *     target's PK; for MANY_TO_MANY the join entity holds FKs to both ends).
 *   - `parseDDL` normalizes every FK-derived relationship's `cardinality` to the
 *     sentinel value `ONE_TO_MANY`, because the true cardinality is unknowable
 *     from DDL.
 *
 *   => Therefore task 4.2 MUST NOT compare the parsed `relationships` array
 *      against the source model's raw `relationships` array (direction and
 *      cardinality differ, especially for MANY_TO_MANY). Instead it projects
 *      BOTH sides onto the same FK-derived edge set — the set of
 *      `(dependentEntity, referencedEntity, referencedAttribute)` triples taken
 *      from FOREIGN_KEY constraints — and compares those. That edge set is
 *      recoverable identically from the source model (via its FK constraints)
 *      and from the parsed model (via the parsed FK constraints), making the
 *      relationship round-trip exact. `relationshipEdges(model)` below is the
 *      single shared projection both directions use.
 *
 * ## Primary-key representation (coordinated with task 4.2)
 *
 * `parseDDL` reconstructs the PK both as `entity.primaryKey` AND as a
 * `PRIMARY_KEY` attribute constraint on each PK column. The source model
 * (produced by `constraints.ts`) represents the PK only via `entity.primaryKey`
 * (it does not add `PRIMARY_KEY` attribute constraints). So task 4.2 MUST
 * compare primary keys via `entity.primaryKey` (set per entity) — or normalize
 * both sides by deriving `PRIMARY_KEY` membership from `entity.primaryKey` — and
 * MUST NOT rely on the presence/absence of `PRIMARY_KEY` attribute constraints.
 * `constraintProjection(model)` below provides this normalized, PK-via-
 * `primaryKey` view for both directions.
 *
 * ## isJoinEntity
 *
 * `isJoinEntity` is best-effort inferred (an entity whose primary key is made up
 * of two or more columns that are all foreign keys — the M:N join-table shape).
 * Task 4.2's entity equality compares name + attribute names + attribute types
 * only (Req 12.2), and relationship equality uses the FK-edge projection above,
 * so `isJoinEntity` does NOT participate in round-trip equality; it is recorded
 * for completeness only.
 */
import type { DataModel, DataType, MigrationScript } from '../model/types.js';
import { type Result } from '../model/result.js';
/**
 * Map a PostgreSQL type string back to a Data_Model {@link DataType} using the
 * inverse of the Schema_Generator's fixed mapping. Falls back to `TEXT` for an
 * unrecognized type — the generator only emits types from the fixed table, so
 * this fallback is purely defensive and never hit for our own DDL.
 */
export declare function mapPostgresType(pgType: string): DataType;
/**
 * Parse a generated {@link MigrationScript} back into a {@link DataModel},
 * reconstructing entities (with attributes + data types), constraints
 * (PRIMARY_KEY, NOT_NULL, UNIQUE, FOREIGN_KEY), and relationships (derived from
 * foreign keys with a normalized `ONE_TO_MANY` cardinality — see the module note
 * on the relationship-derivation convention used jointly with task 4.2).
 *
 * The parse routes on each statement's `kind` (the kinds the Schema_Generator
 * tags) and parses the SQL text for the structural detail:
 *   - `CREATE_TABLE` -> an entity with columns + PK;
 *   - `ADD_FK`       -> a FOREIGN_KEY constraint on the holding column, plus an
 *                       FK-derived relationship edge;
 *   - `CREATE_INDEX` -> ignored (indexes are derived from FKs and are not part
 *                       of entity/relationship/constraint equality).
 */
export declare function parseDDL(ddl: MigrationScript): DataModel;
/**
 * The FK-derived relationship edge set used as the consistent basis for
 * round-trip relationship comparison (see the module note). Each FOREIGN_KEY in
 * the model becomes a `(source, target, references attribute)` edge from the
 * FK-holding entity to the referenced entity. Deduplicated and stable. Task 4.2
 * derives this from BOTH the source and parsed models and compares the sets,
 * rather than comparing the raw `relationships` arrays (whose direction and
 * cardinality are not DDL-recoverable).
 */
export declare function relationshipEdges(model: DataModel): {
    source: string;
    target: string;
    attribute: string;
}[];
/**
 * The normalized constraint view both directions compare in task 4.2 (Req 12.4).
 * Represents the PK via `entity.primaryKey` (NOT via `PRIMARY_KEY` attribute
 * constraints, which the source model omits), plus the FK / UNIQUE / NOT_NULL
 * sets keyed by entity+attribute. Provided here so the parse direction and the
 * comparison (4.2) share one definition and cannot drift.
 */
export type ConstraintProjection = {
    /** entityName -> ordered primary-key column list. */
    primaryKeys: Map<string, string[]>;
    /** Set of `entity\0attribute` columns marked NOT NULL. */
    notNull: Set<string>;
    /** Set of `entity\0attribute` columns marked UNIQUE. */
    unique: Set<string>;
    /** Set of `entity\0attribute\0refEntity\0refAttribute` foreign-key edges. */
    foreignKeys: Set<string>;
};
/** Build the normalized {@link ConstraintProjection} for a model. */
export declare function constraintProjection(model: DataModel): ConstraintProjection;
/**
 * The structural diff reported when the parsed-back Data_Model differs from the
 * source (Req 12.5). Task 4.2 populates this; defined here so the public
 * surface is stable. Each list names the specific elements added, lost, or
 * altered across entities, relationships, and constraints.
 */
export type RoundTripDiff = {
    message: string;
    entities?: {
        added: string[];
        lost: string[];
        altered: string[];
    };
    relationships?: {
        added: string[];
        lost: string[];
        altered: string[];
    };
    constraints?: {
        added: string[];
        lost: string[];
        altered: string[];
    };
};
/**
 * The Round-Trip Verifier surface (Req 12). `parseDDL` is implemented in this
 * module (task 4.1); `verify` is the deploy gate implemented in task 4.2.
 */
export interface RoundTripVerifier {
    /** DDL -> IR (task 4.1). */
    parseDDL(ddl: MigrationScript): DataModel;
    /** Compare parsed-back IR to the source, failing closed on any diff (4.2). */
    verify(ddl: MigrationScript, source: DataModel): Result<void, RoundTripDiff>;
}
/**
 * Deploy-gate verification (Req 12.1, 12.2–12.5). Parses the generated `ddl`
 * back into a Data_Model with {@link parseDDL} and structurally compares it to
 * `source`:
 *   - entity sets by name + attribute names + data types (Req 12.2);
 *   - the FK-derived relationship edge sets via {@link relationshipEdges}
 *     (Req 12.3 — the DDL-recoverable convention; see the module note);
 *   - the normalized constraint sets (PK via `entity.primaryKey`, plus
 *     NOT_NULL / UNIQUE / FOREIGN_KEY) via {@link constraintProjection}
 *     (Req 12.4);
 *   - table count == entity count: the parsed entity count equals the source
 *     entity count (Req 12.1).
 *
 * Returns `ok(undefined)` when every comparison matches. Otherwise fails closed
 * with a populated {@link RoundTripDiff} naming the specific entities,
 * relationships, and constraints that were added, lost, or altered (Req 12.5).
 * `source` is only read, never mutated.
 */
export declare function verify(ddl: MigrationScript, source: DataModel): Result<void, RoundTripDiff>;
/**
 * Default {@link RoundTripVerifier} implementation wiring the module's
 * {@link parseDDL} (task 4.1) and {@link verify} (task 4.2) into the port the
 * orchestrator depends on for the VERIFYING → DEPLOYING deploy gate (task
 * 12.1). Stateless; safe to share a single instance.
 */
export declare class DefaultRoundTripVerifier implements RoundTripVerifier {
    parseDDL(ddl: MigrationScript): DataModel;
    verify(ddl: MigrationScript, source: DataModel): Result<void, RoundTripDiff>;
}
