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
import { ok, err } from '../model/result.js';
import { DATA_TYPE_TO_POSTGRES } from './schemaGenerator.js';
// ---------------------------------------------------------------------------
// Inverse PostgreSQL-type -> DataType mapping (built from DATA_TYPE_TO_POSTGRES)
// ---------------------------------------------------------------------------
/**
 * The inverse of {@link DATA_TYPE_TO_POSTGRES}, keyed by the normalized
 * (lowercased, whitespace-stripped) PostgreSQL type string. Built from the
 * forward table so the two directions can never drift:
 * `uuid -> UUID`, `text -> TEXT`, `varchar(255) -> VARCHAR`,
 * `integer -> INTEGER`, `bigint -> BIGINT`, `numeric -> NUMERIC`,
 * `boolean -> BOOLEAN`, `date -> DATE`, `timestamptz -> TIMESTAMP`,
 * `jsonb -> JSON`.
 */
const POSTGRES_TO_DATA_TYPE = (() => {
    const inverse = {};
    for (const [dataType, pgType] of Object.entries(DATA_TYPE_TO_POSTGRES)) {
        inverse[normalizePgType(pgType)] = dataType;
    }
    return inverse;
})();
/** Normalize a PG type string for inverse lookup (lowercase, no whitespace). */
function normalizePgType(pgType) {
    return pgType.toLowerCase().replace(/\s+/g, '');
}
/**
 * Map a PostgreSQL type string back to a Data_Model {@link DataType} using the
 * inverse of the Schema_Generator's fixed mapping. Falls back to `TEXT` for an
 * unrecognized type — the generator only emits types from the fixed table, so
 * this fallback is purely defensive and never hit for our own DDL.
 */
export function mapPostgresType(pgType) {
    return POSTGRES_TO_DATA_TYPE[normalizePgType(pgType)] ?? 'TEXT';
}
// ---------------------------------------------------------------------------
// Quoted-identifier helpers
// ---------------------------------------------------------------------------
/** Unescape a double-quoted identifier body (`""` -> `"`). */
function unquote(body) {
    return body.replace(/""/g, '"');
}
/** Match a single double-quoted identifier, capturing its raw (escaped) body. */
const QUOTED_IDENT = '"((?:[^"]|"")*)"';
/** Extract every double-quoted identifier inside a fragment, in order. */
function parseIdentList(fragment) {
    const idents = [];
    const re = new RegExp(QUOTED_IDENT, 'g');
    let match;
    while ((match = re.exec(fragment)) !== null) {
        idents.push(unquote(match[1]));
    }
    return idents;
}
/**
 * Split a comma-separated list at the top level only — commas inside
 * parentheses (e.g. `varchar(255)`, `PRIMARY KEY ("a", "b")`) or inside a
 * quoted identifier do not split. Returns trimmed, non-empty items.
 */
function splitTopLevel(input) {
    const items = [];
    let depth = 0;
    let inQuote = false;
    let current = '';
    for (const ch of input) {
        if (ch === '"') {
            // A doubled "" toggles twice (stays inside); a lone " opens/closes.
            inQuote = !inQuote;
            current += ch;
            continue;
        }
        if (!inQuote) {
            if (ch === '(') {
                depth += 1;
            }
            else if (ch === ')') {
                depth -= 1;
            }
            else if (ch === ',' && depth === 0) {
                items.push(current.trim());
                current = '';
                continue;
            }
        }
        current += ch;
    }
    if (current.trim().length > 0) {
        items.push(current.trim());
    }
    return items.filter((item) => item.length > 0);
}
// ---------------------------------------------------------------------------
// Statement parsers
// ---------------------------------------------------------------------------
const CREATE_TABLE_RE = new RegExp(`^CREATE\\s+TABLE\\s+${QUOTED_IDENT}\\s*\\(([\\s\\S]*)\\)\\s*;?\\s*$`, 'i');
const COLUMN_RE = new RegExp(`^${QUOTED_IDENT}\\s+([\\s\\S]+)$`);
const ADD_FK_RE = new RegExp(`^ALTER\\s+TABLE\\s+${QUOTED_IDENT}\\s+ADD\\s+CONSTRAINT\\s+${QUOTED_IDENT}\\s+` +
    `FOREIGN\\s+KEY\\s*\\(\\s*${QUOTED_IDENT}\\s*\\)\\s+` +
    `REFERENCES\\s+${QUOTED_IDENT}\\s*\\(\\s*${QUOTED_IDENT}\\s*\\)\\s*;?\\s*$`, 'i');
/**
 * Parse a single `CREATE TABLE` statement into an {@link Entity}. Reconstructs
 * each column (name + data type) with its inline NOT NULL / UNIQUE constraints,
 * and the primary key from the table-level `PRIMARY KEY (...)` clause — recorded
 * both as `entity.primaryKey` and as a `PRIMARY_KEY` constraint on each PK
 * column. Foreign keys are added later from the `ALTER TABLE` statements.
 */
function parseCreateTable(sql) {
    const match = sql.match(CREATE_TABLE_RE);
    if (match === null) {
        return undefined;
    }
    const entityName = unquote(match[1]);
    const body = match[2];
    const attributes = [];
    let primaryKey = [];
    for (const item of splitTopLevel(body)) {
        if (/^PRIMARY\s+KEY\b/i.test(item)) {
            primaryKey = parseIdentList(item);
            continue;
        }
        const colMatch = item.match(COLUMN_RE);
        if (colMatch === null) {
            continue; // Unknown clause; our generator emits none.
        }
        const name = unquote(colMatch[1]);
        let rest = colMatch[2].trim();
        const constraints = [];
        if (/\bNOT\s+NULL\b/i.test(rest)) {
            constraints.push({ kind: 'NOT_NULL' });
        }
        if (/\bUNIQUE\b/i.test(rest)) {
            constraints.push({ kind: 'UNIQUE' });
        }
        // Strip the recognized modifiers; whatever remains is the type token.
        rest = rest
            .replace(/\bNOT\s+NULL\b/gi, '')
            .replace(/\bUNIQUE\b/gi, '')
            .trim();
        attributes.push({ name, dataType: mapPostgresType(rest), constraints });
    }
    // Record PK membership as a PRIMARY_KEY attribute constraint as well (see the
    // module-level note on PK representation and how task 4.2 compares PKs).
    const pkSet = new Set(primaryKey);
    for (const attribute of attributes) {
        if (pkSet.has(attribute.name)) {
            attribute.constraints.push({ kind: 'PRIMARY_KEY' });
        }
    }
    return { name: entityName, attributes, primaryKey, isJoinEntity: false };
}
/** Parse a single `ALTER TABLE ... ADD CONSTRAINT ... FOREIGN KEY ...`. */
function parseAddForeignKey(sql) {
    const match = sql.match(ADD_FK_RE);
    if (match === null) {
        return undefined;
    }
    // Groups: table, constraintName, column, refEntity, refAttribute.
    return {
        table: unquote(match[1]),
        column: unquote(match[3]),
        refEntity: unquote(match[4]),
        refAttribute: unquote(match[5]),
    };
}
// ---------------------------------------------------------------------------
// isJoinEntity inference (best-effort; not part of round-trip equality)
// ---------------------------------------------------------------------------
/**
 * Infer the M:N join-table shape: a composite primary key (two or more columns)
 * where every primary-key column is also a foreign key. Best-effort only — see
 * the module note; task 4.2's equality does not consider this flag.
 */
function inferIsJoinEntity(entity) {
    if (entity.primaryKey.length < 2) {
        return false;
    }
    const fkColumns = new Set(entity.attributes
        .filter((a) => a.constraints.some((c) => c.kind === 'FOREIGN_KEY'))
        .map((a) => a.name));
    return entity.primaryKey.every((pkCol) => fkColumns.has(pkCol));
}
// ---------------------------------------------------------------------------
// parseDDL — the public DDL -> Data_Model reconstruction (task 4.1)
// ---------------------------------------------------------------------------
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
export function parseDDL(ddl) {
    const entities = [];
    const byName = new Map();
    const foreignKeys = [];
    for (const statement of ddl.statements) {
        routeStatement(statement, entities, byName, foreignKeys);
    }
    // Attach foreign-key constraints to the holding column of the holding entity.
    for (const fk of foreignKeys) {
        const entity = byName.get(fk.table);
        if (entity === undefined) {
            continue;
        }
        const attribute = entity.attributes.find((a) => a.name === fk.column);
        if (attribute === undefined) {
            continue;
        }
        attribute.constraints.push({
            kind: 'FOREIGN_KEY',
            references: { entity: fk.refEntity, attribute: fk.refAttribute },
        });
    }
    // Best-effort join-entity inference (not used by round-trip equality).
    for (const entity of entities) {
        entity.isJoinEntity = inferIsJoinEntity(entity);
    }
    return { entities, relationships: deriveRelationships(entities) };
}
/** Dispatch one statement to its parser, mutating the accumulators. */
function routeStatement(statement, entities, byName, foreignKeys) {
    switch (statement.kind) {
        case 'CREATE_TABLE': {
            const entity = parseCreateTable(statement.sql);
            if (entity !== undefined) {
                entities.push(entity);
                byName.set(entity.name, entity);
            }
            return;
        }
        case 'ADD_FK': {
            const fk = parseAddForeignKey(statement.sql);
            if (fk !== undefined) {
                foreignKeys.push(fk);
            }
            return;
        }
        case 'CREATE_INDEX':
            // Indexes are derived from FK columns; not part of the reconstructed IR.
            return;
        default:
            return;
    }
}
// ---------------------------------------------------------------------------
// Shared FK-derived projections (the consistent convention for task 4.2)
// ---------------------------------------------------------------------------
/**
 * The FK-derived relationship edge set used as the consistent basis for
 * round-trip relationship comparison (see the module note). Each FOREIGN_KEY in
 * the model becomes a `(source, target, references attribute)` edge from the
 * FK-holding entity to the referenced entity. Deduplicated and stable. Task 4.2
 * derives this from BOTH the source and parsed models and compares the sets,
 * rather than comparing the raw `relationships` arrays (whose direction and
 * cardinality are not DDL-recoverable).
 */
export function relationshipEdges(model) {
    const seen = new Set();
    const edges = [];
    for (const entity of model.entities) {
        for (const attribute of entity.attributes) {
            for (const constraint of attribute.constraints) {
                if (constraint.kind !== 'FOREIGN_KEY') {
                    continue;
                }
                const edge = {
                    source: entity.name,
                    target: constraint.references.entity,
                    attribute: constraint.references.attribute,
                };
                const key = `${edge.source}\u0000${edge.target}\u0000${edge.attribute}`;
                if (!seen.has(key)) {
                    seen.add(key);
                    edges.push(edge);
                }
            }
        }
    }
    return edges;
}
/**
 * Derive the `relationships` array for the parsed model from its foreign keys,
 * normalizing every cardinality to `ONE_TO_MANY` (cardinality is not recoverable
 * from DDL). The directed edges follow the generator's FK direction
 * (FK-holding/dependent entity -> referenced entity).
 */
function deriveRelationships(entities) {
    return relationshipEdges({ entities, relationships: [] }).map((edge) => ({
        source: edge.source,
        target: edge.target,
        cardinality: 'ONE_TO_MANY',
    }));
}
/** Build the normalized {@link ConstraintProjection} for a model. */
export function constraintProjection(model) {
    const primaryKeys = new Map();
    const notNull = new Set();
    const unique = new Set();
    const foreignKeys = new Set();
    for (const entity of model.entities) {
        primaryKeys.set(entity.name, [...entity.primaryKey]);
        for (const attribute of entity.attributes) {
            const col = `${entity.name}\u0000${attribute.name}`;
            for (const constraint of attribute.constraints) {
                if (constraint.kind === 'NOT_NULL') {
                    notNull.add(col);
                }
                else if (constraint.kind === 'UNIQUE') {
                    unique.add(col);
                }
                else if (constraint.kind === 'FOREIGN_KEY') {
                    foreignKeys.add(`${col}\u0000${constraint.references.entity}\u0000${constraint.references.attribute}`);
                }
            }
        }
    }
    return { primaryKeys, notNull, unique, foreignKeys };
}
// ---------------------------------------------------------------------------
// Entity comparison helpers (Req 12.2 — name + attribute names + data types)
// ---------------------------------------------------------------------------
/**
 * The comparable signature of an entity for round-trip equality (Req 12.2):
 * its attribute set as sorted `name:dataType` tokens. Entity equality compares
 * name (the map key) plus this signature; it deliberately ignores constraints,
 * `isJoinEntity`, `primaryKey`, and `needsReview` (constraints are compared
 * separately via {@link constraintProjection}; see the module note).
 */
function entitySignature(entity) {
    return entity.attributes
        .map((a) => `${a.name}:${a.dataType}`)
        .sort()
        .join('\u0000');
}
/** Index a model's entities by name -> signature. */
function entitySignatureMap(model) {
    const map = new Map();
    for (const entity of model.entities) {
        map.set(entity.name, entitySignature(entity));
    }
    return map;
}
/**
 * Diff the entity sets of source vs parsed by name + attribute signature
 * (Req 12.2). `added` = present only in parsed, `lost` = present only in
 * source, `altered` = same name but a differing attribute name/type set.
 */
function diffEntities(source, parsed) {
    const sourceSigs = entitySignatureMap(source);
    const parsedSigs = entitySignatureMap(parsed);
    const added = [];
    const lost = [];
    const altered = [];
    for (const name of sourceSigs.keys()) {
        if (!parsedSigs.has(name)) {
            lost.push(name);
        }
        else if (parsedSigs.get(name) !== sourceSigs.get(name)) {
            altered.push(name);
        }
    }
    for (const name of parsedSigs.keys()) {
        if (!sourceSigs.has(name)) {
            added.push(name);
        }
    }
    return { added: added.sort(), lost: lost.sort(), altered: altered.sort() };
}
// ---------------------------------------------------------------------------
// Relationship comparison helpers (Req 12.3 — via the FK-derived edge set)
// ---------------------------------------------------------------------------
/** Render a relationship edge as a stable comparable/display key. */
function edgeKey(edge) {
    return `${edge.source} -> ${edge.target} (${edge.attribute})`;
}
/**
 * Diff the FK-derived relationship edge sets of source vs parsed (Req 12.3).
 * Both sides are projected with {@link relationshipEdges} so the comparison is
 * over the same DDL-recoverable basis (see the module note on why the raw
 * `relationships` arrays are not compared). `added` = edges only in parsed,
 * `lost` = edges only in source. (Relationship edges have no "altered" form —
 * a changed endpoint is a distinct edge, surfacing as one add + one lost.)
 */
function diffRelationships(source, parsed) {
    const sourceKeys = new Set(relationshipEdges(source).map(edgeKey));
    const parsedKeys = new Set(relationshipEdges(parsed).map(edgeKey));
    const added = [...parsedKeys].filter((k) => !sourceKeys.has(k)).sort();
    const lost = [...sourceKeys].filter((k) => !parsedKeys.has(k)).sort();
    return { added, lost, altered: [] };
}
// ---------------------------------------------------------------------------
// Constraint comparison helpers (Req 12.4 — via the normalized projection)
// ---------------------------------------------------------------------------
/** Render an `entity\0attribute` column key for display with a kind label. */
function labelColumn(kind, column) {
    const [entity, attribute] = column.split('\u0000');
    return `${kind} ${entity}.${attribute}`;
}
/** Render an `entity\0attr\0refEntity\0refAttr` FK key for display. */
function labelForeignKey(fk) {
    const [entity, attribute, refEntity, refAttribute] = fk.split('\u0000');
    return `FOREIGN_KEY ${entity}.${attribute} -> ${refEntity}.${refAttribute}`;
}
/**
 * Diff the normalized constraint projections of source vs parsed (Req 12.4).
 * Compares, on the shared {@link constraintProjection} basis:
 *   - primary keys per entity (via `entity.primaryKey`) — a differing column
 *     list on an entity present in both is reported as `altered`;
 *   - NOT NULL and UNIQUE column sets — reported as `added`/`lost`;
 *   - foreign-key edges — reported as `added`/`lost`.
 * Primary keys for entities present on only one side are not reported here —
 * that difference is already surfaced by the entity diff (Req 12.2).
 */
function diffConstraints(source, parsed) {
    const sourceProj = constraintProjection(source);
    const parsedProj = constraintProjection(parsed);
    const added = [];
    const lost = [];
    const altered = [];
    // Primary keys: compare ordered column lists for entities present on both.
    for (const [entity, sourcePk] of sourceProj.primaryKeys) {
        const parsedPk = parsedProj.primaryKeys.get(entity);
        if (parsedPk === undefined) {
            continue; // Entity-level difference; reported by diffEntities.
        }
        if (sourcePk.join('\u0000') !== parsedPk.join('\u0000')) {
            altered.push(`PRIMARY_KEY ${entity}: [${sourcePk.join(', ')}] != [${parsedPk.join(', ')}]`);
        }
    }
    // NOT NULL column set.
    for (const col of sourceProj.notNull) {
        if (!parsedProj.notNull.has(col)) {
            lost.push(labelColumn('NOT_NULL', col));
        }
    }
    for (const col of parsedProj.notNull) {
        if (!sourceProj.notNull.has(col)) {
            added.push(labelColumn('NOT_NULL', col));
        }
    }
    // UNIQUE column set.
    for (const col of sourceProj.unique) {
        if (!parsedProj.unique.has(col)) {
            lost.push(labelColumn('UNIQUE', col));
        }
    }
    for (const col of parsedProj.unique) {
        if (!sourceProj.unique.has(col)) {
            added.push(labelColumn('UNIQUE', col));
        }
    }
    // Foreign-key edge set.
    for (const fk of sourceProj.foreignKeys) {
        if (!parsedProj.foreignKeys.has(fk)) {
            lost.push(labelForeignKey(fk));
        }
    }
    for (const fk of parsedProj.foreignKeys) {
        if (!sourceProj.foreignKeys.has(fk)) {
            added.push(labelForeignKey(fk));
        }
    }
    return { added: added.sort(), lost: lost.sort(), altered: altered.sort() };
}
/** True when an added/lost/altered diff group has no differences. */
function isEmptyDiff(diff) {
    return (diff.added.length === 0 &&
        diff.lost.length === 0 &&
        diff.altered.length === 0);
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
export function verify(ddl, source) {
    const parsed = parseDDL(ddl);
    const entities = diffEntities(source, parsed);
    const relationships = diffRelationships(source, parsed);
    const constraints = diffConstraints(source, parsed);
    // Req 12.1 — table count (one CREATE TABLE per entity) must equal the source
    // entity count. A mismatch is also reflected in the entity added/lost lists.
    const countMatches = parsed.entities.length === source.entities.length;
    if (isEmptyDiff(entities) &&
        isEmptyDiff(relationships) &&
        isEmptyDiff(constraints) &&
        countMatches) {
        return ok(undefined);
    }
    // Build a focused diff carrying only the sections that actually differ.
    const diff = { message: '' };
    const reasons = [];
    if (!countMatches) {
        reasons.push(`table count ${parsed.entities.length} != entity count ${source.entities.length}`);
    }
    if (!isEmptyDiff(entities)) {
        diff.entities = entities;
        reasons.push(summarizeGroup('entities', entities));
    }
    if (!isEmptyDiff(relationships)) {
        diff.relationships = relationships;
        reasons.push(summarizeGroup('relationships', relationships));
    }
    if (!isEmptyDiff(constraints)) {
        diff.constraints = constraints;
        reasons.push(summarizeGroup('constraints', constraints));
    }
    diff.message = `Round-trip verification failed: ${reasons.join('; ')}.`;
    return err(diff);
}
/** Summarize a diff group's added/lost/altered counts for the message. */
function summarizeGroup(label, diff) {
    const parts = [];
    if (diff.added.length > 0) {
        parts.push(`added ${diff.added.join(', ')}`);
    }
    if (diff.lost.length > 0) {
        parts.push(`lost ${diff.lost.join(', ')}`);
    }
    if (diff.altered.length > 0) {
        parts.push(`altered ${diff.altered.join(', ')}`);
    }
    return `${label} { ${parts.join('; ')} }`;
}
/**
 * Default {@link RoundTripVerifier} implementation wiring the module's
 * {@link parseDDL} (task 4.1) and {@link verify} (task 4.2) into the port the
 * orchestrator depends on for the VERIFYING → DEPLOYING deploy gate (task
 * 12.1). Stateless; safe to share a single instance.
 */
export class DefaultRoundTripVerifier {
    parseDDL(ddl) {
        return parseDDL(ddl);
    }
    verify(ddl, source) {
        return verify(ddl, source);
    }
}
//# sourceMappingURL=roundTripVerifier.js.map