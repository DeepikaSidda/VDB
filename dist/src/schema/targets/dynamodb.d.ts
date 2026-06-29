/**
 * DynamoDB target projection (Req 13.2, 13.3).
 *
 * DynamoDB is not a relational engine, so this projection does not emit SQL
 * DDL. Instead it produces a **table design**: one table definition per entity
 * (Req 13.2), each with a designated primary key derived from the entity's
 * Data_Model primary key:
 *
 * - a single-column primary key becomes a partition (HASH) key;
 * - a two-column composite primary key becomes a partition (HASH) key plus a
 *   sort (RANGE) key;
 * - any primary-key columns beyond the first two cannot be expressed in
 *   DynamoDB's two-attribute key schema and are recorded in the report below.
 *
 * Each table definition is serialized as a JSON `CreateTable` description in the
 * `DdlStatement.sql` field with kind `CREATE_TABLE`, so it flows through the
 * same {@link MigrationScript} contract as the relational targets.
 *
 * Because a DynamoDB key schema cannot represent foreign keys, non-key unique
 * constraints, not-null/format/range constraints, or relationships
 * (joins/references), this projection ALSO returns a report identifying each
 * such constraint or relationship it could not represent (Req 13.3).
 *
 * Surfacing the report — design decision:
 * The base {@link TargetProjection.generate} returns only the
 * `MigrationScript` (the table design), keeping the dispatch in
 * `schemaGenerator.generate` uniform across all targets. The richer
 * {@link generateDynamoDbDesign} function returns both the script and the
 * unrepresented-element report. Callers that need the Req 13.3 report
 * (`schemaGenerator.generateDynamoDbDesign`) use that API; callers that only
 * need the table design use the uniform `generate` path.
 */
import type { DataModel, MigrationScript, Relationship } from '../../model/types.js';
import { type Result } from '../../model/result.js';
import type { SchemaGenError } from './relational.js';
import type { TargetProjection } from './targetProjection.js';
/**
 * A single constraint or relationship from the Data_Model that the generated
 * DynamoDB table design does not represent (Req 13.3). Discriminated on `kind`
 * so callers can identify exactly what was dropped and why.
 */
export type UnrepresentedElement = {
    kind: 'FOREIGN_KEY';
    entity: string;
    attribute: string;
    references: {
        entity: string;
        attribute: string;
    };
    reason: string;
} | {
    kind: 'UNIQUE';
    entity: string;
    attribute: string;
    reason: string;
} | {
    kind: 'NOT_NULL';
    entity: string;
    attribute: string;
    reason: string;
} | {
    kind: 'FORMAT';
    entity: string;
    attribute: string;
    format: string;
    reason: string;
} | {
    kind: 'RANGE';
    entity: string;
    attribute: string;
    min?: number;
    max?: number;
    reason: string;
} | {
    kind: 'RELATIONSHIP';
    source: string;
    target: string;
    cardinality: Relationship['cardinality'];
    reason: string;
} | {
    kind: 'COMPOSITE_KEY_OVERFLOW';
    entity: string;
    /** Primary-key columns beyond the partition+sort pair, left unrepresented. */
    columns: string[];
    reason: string;
};
/**
 * The full DynamoDB projection result: the table design plus the report of
 * everything the design could not represent (Req 13.2 + 13.3).
 */
export type DynamoDbDesign = {
    script: MigrationScript;
    unrepresented: UnrepresentedElement[];
};
/**
 * Generate the full DynamoDB design: a table definition per entity with a
 * designated primary key (Req 13.2), plus the report of every constraint and
 * relationship the design could not represent (Req 13.3).
 *
 * Returns a `Result` for signature symmetry with the other projections; the
 * DynamoDB projection has no failure conditions of its own (the key-type
 * mapping is total over the `DataType` union), so it always succeeds.
 */
export declare function generateDynamoDbDesign(model: DataModel): Result<DynamoDbDesign, SchemaGenError>;
/**
 * Project the model into the DynamoDB table-design {@link MigrationScript}
 * only (Req 13.2). The Req 13.3 unrepresented-element report is available via
 * {@link generateDynamoDbDesign}.
 */
export declare function generateDynamoDb(model: DataModel): Result<MigrationScript, SchemaGenError>;
/**
 * The DynamoDB {@link TargetProjection} plug-in. Its `generate` returns the
 * table design as a `MigrationScript`; use {@link generateDynamoDbDesign} for
 * the accompanying unrepresented-element report.
 */
export declare const dynamoDbProjection: TargetProjection;
