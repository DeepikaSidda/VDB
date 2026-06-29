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
import { ok, err } from '../../model/result.js';
// ---------------------------------------------------------------------------
// DataType -> Aurora PostgreSQL mapping (fixed table from the design)
// ---------------------------------------------------------------------------
/**
 * The fixed Data_Model `DataType` -> Aurora PostgreSQL type mapping from the
 * design's "DataType -> Aurora PostgreSQL mapping" section. Aurora DSQL is
 * PostgreSQL-compatible, so the same table serves both relational targets. An
 * attribute whose `dataType` is not a key of this table triggers Req 3.8.
 */
export const DATA_TYPE_TO_POSTGRES = {
    UUID: 'uuid',
    TEXT: 'text',
    VARCHAR: 'varchar(255)',
    INTEGER: 'integer',
    BIGINT: 'bigint',
    NUMERIC: 'numeric',
    BOOLEAN: 'boolean',
    DATE: 'date',
    TIMESTAMP: 'timestamptz',
    JSON: 'jsonb',
};
/**
 * Map a Data_Model {@link DataType} to its Aurora PostgreSQL type string.
 *
 * Accepts a plain `string` (not just the `DataType` union) so callers handling
 * untrusted/raw models can detect an unmappable type: a `string` that is not a
 * supported `DataType` returns `undefined` (the Req 3.8 condition). For a
 * well-formed model every attribute's type is a `DataType` and this always
 * returns the mapped string.
 */
export function mapDataType(dataType) {
    return DATA_TYPE_TO_POSTGRES[dataType];
}
// ---------------------------------------------------------------------------
// Identifier quoting
// ---------------------------------------------------------------------------
/**
 * Quote a SQL identifier with double quotes so names round-trip faithfully
 * (preserving case and avoiding keyword collisions). Embedded double quotes
 * are escaped per the SQL standard by doubling.
 */
export function quoteIdent(name) {
    return `"${name.replace(/"/g, '""')}"`;
}
/** Extract this entity's foreign-key columns, in attribute order. */
export function foreignKeyColumns(entity) {
    const fks = [];
    for (const attribute of entity.attributes) {
        for (const constraint of attribute.constraints) {
            if (constraint.kind === 'FOREIGN_KEY') {
                fks.push({ attribute, references: constraint.references });
            }
        }
    }
    return fks;
}
// ---------------------------------------------------------------------------
// Statement builders
// ---------------------------------------------------------------------------
/** Render a single column definition line, with inline NOT NULL / UNIQUE. */
function buildColumnDefinition(attribute) {
    // `generateRelational` validates types up front (Req 3.8), so for any model
    // that reaches here the type is always mappable; the `?? attribute.dataType`
    // fallback is purely defensive so this helper never emits an empty type.
    const pgType = mapDataType(attribute.dataType) ?? attribute.dataType;
    const modifiers = [];
    if (attribute.constraints.some((c) => c.kind === 'NOT_NULL')) {
        modifiers.push('NOT NULL');
    }
    if (attribute.constraints.some((c) => c.kind === 'UNIQUE')) {
        modifiers.push('UNIQUE');
    }
    const parts = [quoteIdent(attribute.name), pgType, ...modifiers];
    return `  ${parts.join(' ')}`;
}
/**
 * Build the `CREATE TABLE` statement for an entity (Req 3.1, 3.2, 3.4): every
 * column with its mapped type and inline unique/not-null constraints, plus the
 * primary key as a single (possibly composite) table-level constraint.
 */
function buildCreateTable(entity) {
    const lines = entity.attributes.map(buildColumnDefinition);
    if (entity.primaryKey.length > 0) {
        const pkColumns = entity.primaryKey.map(quoteIdent).join(', ');
        lines.push(`  PRIMARY KEY (${pkColumns})`);
    }
    const sql = `CREATE TABLE ${quoteIdent(entity.name)} (\n${lines.join(',\n')}\n);`;
    return { sql, kind: 'CREATE_TABLE' };
}
/**
 * Build the foreign-key constraint statements (Req 3.3). Each FK column on the
 * dependent entity becomes an `ALTER TABLE ... ADD CONSTRAINT ... FOREIGN KEY`
 * referencing the target entity's primary-key attribute.
 */
function buildForeignKeyStatements(entities) {
    const statements = [];
    for (const entity of entities) {
        for (const fk of foreignKeyColumns(entity)) {
            const constraintName = `fk_${entity.name}_${fk.attribute.name}`;
            const sql = `ALTER TABLE ${quoteIdent(entity.name)} ` +
                `ADD CONSTRAINT ${quoteIdent(constraintName)} ` +
                `FOREIGN KEY (${quoteIdent(fk.attribute.name)}) ` +
                `REFERENCES ${quoteIdent(fk.references.entity)} ` +
                `(${quoteIdent(fk.references.attribute)});`;
            statements.push({ sql, kind: 'ADD_FK' });
        }
    }
    return statements;
}
/**
 * Build exactly one index per foreign-key column (Req 3.5).
 */
function buildForeignKeyIndexStatements(entities) {
    const statements = [];
    for (const entity of entities) {
        for (const fk of foreignKeyColumns(entity)) {
            const indexName = `idx_${entity.name}_${fk.attribute.name}`;
            const sql = `CREATE INDEX ${quoteIdent(indexName)} ` +
                `ON ${quoteIdent(entity.name)} (${quoteIdent(fk.attribute.name)});`;
            statements.push({ sql, kind: 'CREATE_INDEX' });
        }
    }
    return statements;
}
// ---------------------------------------------------------------------------
// Validation — detect every error condition BEFORE building any statement so a
// failure emits no DDL at all (Req 3.10, fail closed).
// ---------------------------------------------------------------------------
/**
 * Req 3.7 — referential closure. Every `Relationship.source`/`target` (I6) and
 * every `FOREIGN_KEY.references.entity` (I5) must name an entity defined in the
 * model. Returns the first violation found, or `undefined` if all references
 * resolve.
 */
export function findUndefinedEntity(model) {
    const defined = new Set(model.entities.map((e) => e.name));
    for (const rel of model.relationships) {
        if (!defined.has(rel.source)) {
            return {
                kind: 'UNDEFINED_ENTITY',
                message: `Relationship references undefined source entity "${rel.source}".`,
                relationship: { source: rel.source, target: rel.target },
                entity: rel.source,
            };
        }
        if (!defined.has(rel.target)) {
            return {
                kind: 'UNDEFINED_ENTITY',
                message: `Relationship references undefined target entity "${rel.target}".`,
                relationship: { source: rel.source, target: rel.target },
                entity: rel.target,
            };
        }
    }
    for (const entity of model.entities) {
        for (const fk of foreignKeyColumns(entity)) {
            if (!defined.has(fk.references.entity)) {
                return {
                    kind: 'UNDEFINED_ENTITY',
                    message: `Foreign key "${entity.name}.${fk.attribute.name}" references ` +
                        `undefined entity "${fk.references.entity}".`,
                    relationship: { source: entity.name, target: fk.references.entity },
                    entity: fk.references.entity,
                };
            }
        }
    }
    return undefined;
}
/**
 * Req 3.8 — every attribute's data type must map to a PostgreSQL type. Returns
 * the first attribute whose type is unmappable (`mapDataType` returns
 * `undefined`), or `undefined` if all types map.
 */
export function findUnmappableType(model) {
    for (const entity of model.entities) {
        for (const attribute of entity.attributes) {
            if (mapDataType(attribute.dataType) === undefined) {
                return {
                    kind: 'UNMAPPABLE_TYPE',
                    message: `Column "${entity.name}.${attribute.name}" has data type ` +
                        `"${attribute.dataType}" which cannot be mapped to an Aurora ` +
                        `PostgreSQL type.`,
                    entity: entity.name,
                    attribute: attribute.name,
                    dataType: attribute.dataType,
                };
            }
        }
    }
    return undefined;
}
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
export function topologicallyOrderEntities(model) {
    const entities = model.entities;
    const defined = new Set(entities.map((e) => e.name));
    // dependsOn[e] = set of entities `e` references and must be created after.
    const dependsOn = new Map();
    for (const entity of entities) {
        dependsOn.set(entity.name, new Set());
    }
    for (const entity of entities) {
        for (const fk of foreignKeyColumns(entity)) {
            const ref = fk.references.entity;
            if (ref !== entity.name && defined.has(ref)) {
                dependsOn.get(entity.name).add(ref);
            }
        }
    }
    // dependents[r] = entities that reference `r` (decremented when `r` is placed).
    const dependents = new Map();
    for (const entity of entities) {
        dependents.set(entity.name, []);
    }
    for (const [name, deps] of dependsOn) {
        for (const dep of deps) {
            dependents.get(dep).push(name);
        }
    }
    const indegree = new Map();
    for (const entity of entities) {
        indegree.set(entity.name, dependsOn.get(entity.name).size);
    }
    const ordered = [];
    const placed = new Set();
    while (ordered.length < entities.length) {
        // Ready = unplaced entities with no outstanding dependencies, in model order.
        const ready = entities.filter((e) => !placed.has(e.name) && indegree.get(e.name) === 0);
        if (ready.length === 0) {
            break; // No ordering possible — remaining entities form a cycle.
        }
        for (const entity of ready) {
            ordered.push(entity);
            placed.add(entity.name);
        }
        for (const entity of ready) {
            for (const dependent of dependents.get(entity.name)) {
                indegree.set(dependent, indegree.get(dependent) - 1);
            }
        }
    }
    if (ordered.length < entities.length) {
        const cycleEntities = entities
            .filter((e) => !placed.has(e.name))
            .map((e) => e.name);
        return err({
            kind: 'CYCLIC_DEPENDENCY',
            message: `Foreign-key dependencies form a cycle with no valid ordering ` +
                `among entities: ${cycleEntities.join(', ')}.`,
            entities: cycleEntities,
        });
    }
    return ok(ordered);
}
// ---------------------------------------------------------------------------
// Shared relational projection
// ---------------------------------------------------------------------------
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
export function generateRelational(model, target) {
    // Req 3.7 — relationships and FK references must name defined entities.
    const undefinedEntity = findUndefinedEntity(model);
    if (undefinedEntity) {
        return err(undefinedEntity);
    }
    // Req 3.8 — every attribute's data type must be mappable.
    const unmappableType = findUnmappableType(model);
    if (unmappableType) {
        return err(unmappableType);
    }
    // Req 3.6 / 3.9 — order CREATE TABLEs; reject unorderable cycles.
    const ordering = topologicallyOrderEntities(model);
    if (!ordering.ok) {
        return ordering;
    }
    const orderedEntities = ordering.value;
    const createTableStatements = orderedEntities.map(buildCreateTable);
    const foreignKeyStatements = buildForeignKeyStatements(orderedEntities);
    const indexStatements = buildForeignKeyIndexStatements(orderedEntities);
    const statements = [
        ...createTableStatements,
        ...foreignKeyStatements,
        ...indexStatements,
    ];
    return ok({ target, statements });
}
//# sourceMappingURL=relational.js.map