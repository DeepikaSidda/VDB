/**
 * Deterministic post-processing of a raw, untrusted `RawCandidateModel` (as
 * emitted by the LLM) into a well-formed `DataModel` that satisfies the IR
 * invariants I1–I6 (see `src/model/invariants.ts`).
 *
 * Design principle "Model first, generate second": the LLM's output is never
 * trusted blindly. This module repairs the *structural* guarantees the LLM may
 * miss — exactly one primary key per entity, a supported data type on every
 * attribute, a valid cardinality on every relationship, and a materialized
 * join entity (with foreign keys to both endpoints' primary keys) for every
 * many-to-many relationship.
 *
 * Scope (task 2.2): structural normalization only. *Constraint inference*
 * (unique / not-null / email-format / numeric-range, and foreign-key
 * constraints for ordinary relationships) is layered on top in task 2.3. The
 * one exception is the foreign keys on synthesized join entities, which are
 * structural and required for invariant I4, so they are produced here.
 *
 * The module is a pure function of its input and follows the fail-closed
 * `Result` discipline: it returns a `NO_DATA_MODEL` error (and no partial
 * model) when no entity can be inferred (Requirement 1.8).
 */
import { err, ok, isErr } from '../model/result.js';
import { validateDataModel } from '../model/invariants.js';
// ---------------------------------------------------------------------------
// Default mappings (documented decisions)
// ---------------------------------------------------------------------------
/**
 * Free-form data-type string → supported `DataType`. Keys are matched
 * case-insensitively after trimming. Anything not listed here (including a
 * missing/empty type) maps to the documented default `TEXT` — the most
 * permissive supported type, so an unrecognized type never blocks generation.
 */
const DATA_TYPE_ALIASES = {
    // UUID
    uuid: 'UUID', guid: 'UUID',
    // TEXT (also the catch-all default)
    text: 'TEXT', string: 'TEXT', str: 'TEXT', longtext: 'TEXT', clob: 'TEXT',
    email: 'TEXT', url: 'TEXT', enum: 'TEXT',
    // VARCHAR
    varchar: 'VARCHAR', char: 'VARCHAR', charactervarying: 'VARCHAR',
    character: 'VARCHAR',
    // INTEGER
    integer: 'INTEGER', int: 'INTEGER', int4: 'INTEGER', smallint: 'INTEGER',
    serial: 'INTEGER',
    // BIGINT
    bigint: 'BIGINT', int8: 'BIGINT', long: 'BIGINT', bigserial: 'BIGINT',
    // NUMERIC
    numeric: 'NUMERIC', decimal: 'NUMERIC', number: 'NUMERIC', float: 'NUMERIC',
    double: 'NUMERIC', real: 'NUMERIC', money: 'NUMERIC', price: 'NUMERIC',
    // BOOLEAN
    boolean: 'BOOLEAN', bool: 'BOOLEAN',
    // DATE
    date: 'DATE',
    // TIMESTAMP
    timestamp: 'TIMESTAMP', timestamptz: 'TIMESTAMP', datetime: 'TIMESTAMP',
    time: 'TIMESTAMP',
    // JSON
    json: 'JSON', jsonb: 'JSON', object: 'JSON',
};
/** Free-form cardinality labels (alphanumerics only) → MANY_TO_MANY. */
const MANY_TO_MANY_LABELS = new Set([
    'manytomany', 'manymany', 'mtm', 'm2m', 'mn', 'nm', 'mm', 'nn', 'ntom',
    'mton', 'nton', 'ntn',
]);
/** Free-form cardinality labels (alphanumerics only) → ONE_TO_ONE. */
const ONE_TO_ONE_LABELS = new Set([
    'onetoone', 'oneone', 'oto', 'o2o', '11', '1to1',
]);
/**
 * Free-form cardinality labels (alphanumerics only) → ONE_TO_MANY. This set
 * also folds many-to-one labels into ONE_TO_MANY: the IR has no MANY_TO_ONE
 * member, and a many-to-one is the same shape as a one-to-many viewed from the
 * other endpoint, so it is normalized to ONE_TO_MANY.
 */
const ONE_TO_MANY_LABELS = new Set([
    'onetomany', 'onemany', 'otm', 'o2m', '1n', '1m', '1tomany', '1ton',
    'hasmany', 'manytoone', 'manyone', 'mto', 'm2o', 'n1', 'm1', '1tom',
    'belongsto',
]);
// ---------------------------------------------------------------------------
// Public mapping helpers (exported for reuse/testing)
// ---------------------------------------------------------------------------
/**
 * Map a free-form data-type string onto exactly one supported `DataType`
 * (Requirement 1.4). Unknown or missing types default to `TEXT`.
 */
export function normalizeDataType(raw) {
    if (typeof raw !== 'string') {
        return 'TEXT';
    }
    const key = raw.trim().toLowerCase();
    return DATA_TYPE_ALIASES[key] ?? 'TEXT';
}
/**
 * Map a free-form cardinality label onto exactly one of the three allowed
 * cardinalities (Requirement 1.3). Unknown or missing labels default to
 * `ONE_TO_MANY`, the most common relational cardinality.
 */
export function normalizeCardinality(raw) {
    const key = typeof raw === 'string' ? raw.toLowerCase().replace(/[^a-z0-9]/g, '') : '';
    if (MANY_TO_MANY_LABELS.has(key)) {
        return 'MANY_TO_MANY';
    }
    if (ONE_TO_ONE_LABELS.has(key)) {
        return 'ONE_TO_ONE';
    }
    if (ONE_TO_MANY_LABELS.has(key)) {
        return 'ONE_TO_MANY';
    }
    return 'ONE_TO_MANY';
}
// ---------------------------------------------------------------------------
// Small structural helpers
// ---------------------------------------------------------------------------
/** Reserve a unique name within `taken`, suffixing `_2`, `_3`, … on collision. */
function uniqueName(base, taken) {
    if (!taken.has(base)) {
        taken.add(base);
        return base;
    }
    let i = 2;
    while (taken.has(`${base}_${i}`)) {
        i += 1;
    }
    const name = `${base}_${i}`;
    taken.add(name);
    return name;
}
/** Remove duplicates while preserving first-seen order. */
function dedupe(values) {
    const seen = new Set();
    const out = [];
    for (const v of values) {
        if (!seen.has(v)) {
            seen.add(v);
            out.push(v);
        }
    }
    return out;
}
function trimmedString(value) {
    return typeof value === 'string' ? value.trim() : '';
}
// ---------------------------------------------------------------------------
// Entity / attribute / primary-key normalization
// ---------------------------------------------------------------------------
/**
 * Normalize one raw entity's attributes and primary key.
 *
 * - Each attribute is given a non-empty unique name and exactly one supported
 *   data type; nameless or duplicate-named attributes are dropped. Constraints
 *   are intentionally left empty here — constraint inference is task 2.3.
 * - The primary key is taken from the raw entity's `primaryKey` when those
 *   names resolve to real attributes (supports composite keys). Otherwise a
 *   surrogate `id` (UUID) key is synthesized so every entity has exactly one
 *   non-empty primary key (Requirements 1.2, 2.6).
 */
function normalizeEntityBody(rawEntity) {
    const rawAttrs = Array.isArray(rawEntity.attributes)
        ? rawEntity.attributes
        : [];
    const takenAttrNames = new Set();
    const attributes = [];
    for (const rawAttr of rawAttrs) {
        const name = trimmedString(rawAttr?.name);
        if (name.length === 0 || takenAttrNames.has(name)) {
            continue;
        }
        takenAttrNames.add(name);
        attributes.push({
            name,
            dataType: normalizeDataType(rawAttr?.dataType),
            constraints: [],
        });
    }
    // Use the inferred primary key when it resolves to real attributes.
    const requestedPk = Array.isArray(rawEntity.primaryKey)
        ? rawEntity.primaryKey
        : [];
    const primaryKey = dedupe(requestedPk
        .map((n) => trimmedString(n))
        .filter((n) => takenAttrNames.has(n)));
    if (primaryKey.length > 0) {
        return { attributes, primaryKey };
    }
    // No usable PK inferred: reuse an existing `id` attribute if present,
    // otherwise synthesize a surrogate `id` (UUID) key (Requirement 2.6).
    if (takenAttrNames.has('id')) {
        return { attributes, primaryKey: ['id'] };
    }
    const surrogateName = uniqueName('id', takenAttrNames);
    const surrogate = {
        name: surrogateName,
        dataType: 'UUID',
        constraints: [],
    };
    // Prepend so the surrogate key reads as the leading column.
    return { attributes: [surrogate, ...attributes], primaryKey: [surrogateName] };
}
/**
 * Build a join entity for a many-to-many relationship (Requirement 1.5,
 * invariant I4). It carries a foreign-key attribute for each primary-key
 * column of both endpoints; the join entity's own primary key is the composite
 * of those foreign-key columns, so it satisfies I1. Self many-to-many
 * relationships are handled because colliding column names are uniquified.
 */
function buildJoinEntity(source, target, takenEntityNames) {
    const name = uniqueName(`${source.name}_${target.name}`, takenEntityNames);
    const takenAttrNames = new Set();
    const attributes = [];
    const primaryKey = [];
    const addForeignKeys = (endpoint) => {
        for (const pkAttrName of endpoint.primaryKey) {
            const referenced = endpoint.attributes.find((a) => a.name === pkAttrName);
            const columnName = uniqueName(`${endpoint.name}_${pkAttrName}`, takenAttrNames);
            attributes.push({
                name: columnName,
                dataType: referenced?.dataType ?? 'UUID',
                constraints: [
                    {
                        kind: 'FOREIGN_KEY',
                        references: { entity: endpoint.name, attribute: pkAttrName },
                    },
                ],
            });
            primaryKey.push(columnName);
        }
    };
    addForeignKeys(source);
    addForeignKeys(target);
    return { name, attributes, primaryKey, isJoinEntity: true };
}
// ---------------------------------------------------------------------------
// Top-level normalization
// ---------------------------------------------------------------------------
/**
 * Normalize a raw candidate model into a well-formed `DataModel` satisfying
 * invariants I1–I6, or fail closed with a `NO_DATA_MODEL` error when no entity
 * can be inferred (Requirement 1.8).
 *
 * Steps:
 *  1. Normalize entities — drop nameless/duplicate entities; give every
 *     attribute a supported type; assign exactly one primary key per entity
 *     (synthesizing a surrogate when needed).
 *  2. Normalize relationships — map cardinality onto the three allowed values;
 *     drop relationships whose endpoints are not defined entities (so I6 holds).
 *  3. Materialize a join entity for each many-to-many relationship (I4).
 *
 * `validateDataModel` is run as a defensive post-condition: a correct
 * normalization of a non-empty model always passes, so a failure indicates an
 * internal bug and is reported fail-closed rather than emitting a malformed
 * model.
 */
export function normalizeCandidate(raw) {
    const rawEntities = Array.isArray(raw.entities) ? raw.entities : [];
    // Step 1 — entities, attributes, primary keys.
    const takenEntityNames = new Set();
    const entities = [];
    for (const rawEntity of rawEntities) {
        const name = trimmedString(rawEntity?.name);
        if (name.length === 0 || takenEntityNames.has(name)) {
            continue;
        }
        takenEntityNames.add(name);
        const { attributes, primaryKey } = normalizeEntityBody(rawEntity);
        entities.push({ name, attributes, primaryKey, isJoinEntity: false });
    }
    // Req 1.8: fail closed when no entity can be inferred — no partial model.
    if (entities.length === 0) {
        return err({
            kind: 'NO_DATA_MODEL',
            message: 'No Data_Model could be derived from the description: no entity could be inferred.',
        });
    }
    const entityByName = new Map(entities.map((e) => [e.name, e]));
    // Step 2 — relationships. Normalize cardinality and drop dangling endpoints
    // so invariant I6 (referential closure) holds.
    const rawRelationships = Array.isArray(raw.relationships)
        ? raw.relationships
        : [];
    const relationships = [];
    for (const rawRel of rawRelationships) {
        const source = trimmedString(rawRel?.source);
        const target = trimmedString(rawRel?.target);
        if (!entityByName.has(source) || !entityByName.has(target)) {
            continue;
        }
        relationships.push({
            source,
            target,
            cardinality: normalizeCardinality(rawRel?.cardinality),
        });
    }
    // Step 3 — materialize a join entity per many-to-many relationship (I4).
    for (const rel of relationships) {
        if (rel.cardinality !== 'MANY_TO_MANY') {
            continue;
        }
        const source = entityByName.get(rel.source);
        const target = entityByName.get(rel.target);
        if (source === undefined || target === undefined) {
            continue;
        }
        const joinEntity = buildJoinEntity(source, target, takenEntityNames);
        entities.push(joinEntity);
        entityByName.set(joinEntity.name, joinEntity);
    }
    const model = { entities, relationships };
    // Defensive post-condition: a correct normalization always satisfies I1–I6.
    const validated = validateDataModel(model);
    if (isErr(validated)) {
        return err({
            kind: 'NO_DATA_MODEL',
            message: `No valid Data_Model could be produced: normalization violated invariants (${validated.error
                .map((v) => v.invariant)
                .join(', ')}).`,
        });
    }
    return ok(model);
}
//# sourceMappingURL=normalize.js.map