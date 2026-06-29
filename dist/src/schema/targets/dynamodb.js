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
import { ok } from '../../model/result.js';
// ---------------------------------------------------------------------------
// Key-attribute type mapping
// ---------------------------------------------------------------------------
/**
 * Map a Data_Model {@link DataType} to a DynamoDB key attribute type. DynamoDB
 * key attributes must be one of `S` (string), `N` (number), or `B` (binary).
 * Numeric model types map to `N`; everything else is represented as `S`.
 */
function dynamoKeyType(dataType) {
    switch (dataType) {
        case 'INTEGER':
        case 'BIGINT':
        case 'NUMERIC':
            return 'N';
        default:
            return 'S';
    }
}
/**
 * Build the JSON `CreateTable` description for one entity, designating a
 * primary key (partition key, plus a sort key for a two-column composite PK).
 */
function buildTableDefinition(entity) {
    const keySchema = [];
    const attributeDefinitions = [];
    const typeOf = (name) => entity.attributes.find((a) => a.name === name)?.dataType;
    const pk = entity.primaryKey;
    if (pk.length >= 1) {
        const partition = pk[0];
        keySchema.push({ AttributeName: partition, KeyType: 'HASH' });
        attributeDefinitions.push({
            AttributeName: partition,
            AttributeType: dynamoKeyType(typeOf(partition) ?? 'TEXT'),
        });
    }
    if (pk.length >= 2) {
        const sort = pk[1];
        keySchema.push({ AttributeName: sort, KeyType: 'RANGE' });
        attributeDefinitions.push({
            AttributeName: sort,
            AttributeType: dynamoKeyType(typeOf(sort) ?? 'TEXT'),
        });
    }
    const definition = {
        TableName: entity.name,
        KeySchema: keySchema,
        AttributeDefinitions: attributeDefinitions,
        BillingMode: 'PAY_PER_REQUEST',
    };
    return { sql: JSON.stringify(definition, null, 2), kind: 'CREATE_TABLE' };
}
// ---------------------------------------------------------------------------
// Unrepresented-element collection (Req 13.3)
// ---------------------------------------------------------------------------
/**
 * Collect every constraint and relationship the DynamoDB table design cannot
 * represent. The design encodes only the primary key (partition/sort keys);
 * foreign keys, non-PK unique/not-null/format/range constraints, primary-key
 * columns beyond the partition+sort pair, and all relationships are reported.
 */
function collectUnrepresented(model) {
    const report = [];
    for (const entity of model.entities) {
        // Composite primary keys with more than two columns overflow DynamoDB's
        // partition+sort key schema; the extra key columns are not represented.
        if (entity.primaryKey.length > 2) {
            report.push({
                kind: 'COMPOSITE_KEY_OVERFLOW',
                entity: entity.name,
                columns: entity.primaryKey.slice(2),
                reason: `DynamoDB key schema supports at most a partition key and a sort ` +
                    `key; the remaining primary-key columns of "${entity.name}" cannot ` +
                    `be represented as native keys.`,
            });
        }
        for (const attribute of entity.attributes) {
            for (const constraint of attribute.constraints) {
                switch (constraint.kind) {
                    case 'PRIMARY_KEY':
                        // Represented by the table's key schema — not reported.
                        break;
                    case 'FOREIGN_KEY':
                        report.push({
                            kind: 'FOREIGN_KEY',
                            entity: entity.name,
                            attribute: attribute.name,
                            references: constraint.references,
                            reason: `DynamoDB does not enforce foreign-key references; ` +
                                `"${entity.name}.${attribute.name}" -> ` +
                                `"${constraint.references.entity}.${constraint.references.attribute}" ` +
                                `is not represented.`,
                        });
                        break;
                    case 'UNIQUE':
                        report.push({
                            kind: 'UNIQUE',
                            entity: entity.name,
                            attribute: attribute.name,
                            reason: `DynamoDB enforces uniqueness only on the primary key; the ` +
                                `unique constraint on "${entity.name}.${attribute.name}" is ` +
                                `not represented.`,
                        });
                        break;
                    case 'NOT_NULL':
                        report.push({
                            kind: 'NOT_NULL',
                            entity: entity.name,
                            attribute: attribute.name,
                            reason: `DynamoDB requires only key attributes; the not-null ` +
                                `constraint on "${entity.name}.${attribute.name}" is not ` +
                                `represented.`,
                        });
                        break;
                    case 'FORMAT':
                        report.push({
                            kind: 'FORMAT',
                            entity: entity.name,
                            attribute: attribute.name,
                            format: constraint.format,
                            reason: `DynamoDB does not enforce value formats; the ` +
                                `${constraint.format} format constraint on ` +
                                `"${entity.name}.${attribute.name}" is not represented.`,
                        });
                        break;
                    case 'RANGE': {
                        const element = {
                            kind: 'RANGE',
                            entity: entity.name,
                            attribute: attribute.name,
                            reason: `DynamoDB does not enforce value ranges; the range ` +
                                `constraint on "${entity.name}.${attribute.name}" is not ` +
                                `represented.`,
                        };
                        if (constraint.min !== undefined)
                            element.min = constraint.min;
                        if (constraint.max !== undefined)
                            element.max = constraint.max;
                        report.push(element);
                        break;
                    }
                    default: {
                        // Exhaustiveness guard: every AttributeConstraint kind is handled.
                        const _exhaustive = constraint;
                        void _exhaustive;
                    }
                }
            }
        }
    }
    // Relationships (joins/references) have no representation in a per-table
    // DynamoDB key design.
    for (const rel of model.relationships) {
        report.push({
            kind: 'RELATIONSHIP',
            source: rel.source,
            target: rel.target,
            cardinality: rel.cardinality,
            reason: `DynamoDB has no cross-table relationships; the ${rel.cardinality} ` +
                `relationship "${rel.source}" -> "${rel.target}" is not represented.`,
        });
    }
    return report;
}
// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------
/**
 * Generate the full DynamoDB design: a table definition per entity with a
 * designated primary key (Req 13.2), plus the report of every constraint and
 * relationship the design could not represent (Req 13.3).
 *
 * Returns a `Result` for signature symmetry with the other projections; the
 * DynamoDB projection has no failure conditions of its own (the key-type
 * mapping is total over the `DataType` union), so it always succeeds.
 */
export function generateDynamoDbDesign(model) {
    const statements = model.entities.map(buildTableDefinition);
    const script = { target: 'DYNAMODB', statements };
    const unrepresented = collectUnrepresented(model);
    return ok({ script, unrepresented });
}
/**
 * Project the model into the DynamoDB table-design {@link MigrationScript}
 * only (Req 13.2). The Req 13.3 unrepresented-element report is available via
 * {@link generateDynamoDbDesign}.
 */
export function generateDynamoDb(model) {
    const design = generateDynamoDbDesign(model);
    return design.ok ? ok(design.value.script) : design;
}
/**
 * The DynamoDB {@link TargetProjection} plug-in. Its `generate` returns the
 * table design as a `MigrationScript`; use {@link generateDynamoDbDesign} for
 * the accompanying unrepresented-element report.
 */
export const dynamoDbProjection = {
    target: 'DYNAMODB',
    generate: generateDynamoDb,
};
//# sourceMappingURL=dynamodb.js.map