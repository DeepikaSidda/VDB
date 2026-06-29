/**
 * Deterministic relational decomposition of flat, tabular records into a
 * well-formed `DataModel` (Requirements 10.2, 10.3) — the document-derived
 * path of the Modeling_Engine [SECONDARY].
 *
 * The Document_Parser produces `ExtractedRecord[]` (rows of named fields).
 * A naive translation would model every dataset as a single flat table, which
 * loses the relational structure that is actually present: when a *group* of
 * two or more fields carries values that repeat across two or more records,
 * those fields describe a separate real-world entity (e.g. the
 * `{facultyName, facultyDept}` of an attendance sheet), not per-row data.
 * Requirement 10.2 mandates that such a group becomes its OWN entity rather
 * than columns of one flat table.
 *
 * This module is deliberately **deterministic and LLM-free**: the
 * decomposition is rule-based so it is fully testable (Property 41). It:
 *
 *  1. Infers each field's `DataType` from its sample values (Req 10.3).
 *  2. Detects repeating field GROUPS via functional-dependency clustering
 *     (see {@link detectRepeatingGroups}) and extracts each into its own
 *     entity (Req 10.2).
 *  3. Builds a main entity from the remaining fields and relates each
 *     extracted entity to it with a ONE_TO_MANY relationship.
 *  4. Runs the assembled candidate through the SAME deterministic
 *     normalization + constraint-inference + invariant-validation pipeline
 *     used by `inferFromPrompt`, so a document-derived model is structurally
 *     identical in shape to a prompt-derived one and satisfies the same
 *     invariants I1–I6 (Req 10.3).
 *
 * It follows the fail-closed `Result` discipline: an empty/field-less input
 * yields a `NO_DATA_MODEL` error and no partial model.
 */
import { randomUUID } from 'node:crypto';
import { err, isErr, ok } from '../model/result.js';
import { validateDataModel } from '../model/invariants.js';
import { normalizeCandidate } from './normalize.js';
import { inferConstraints } from './constraints.js';
const INTEGER_RE = /^-?\d+$/;
const DECIMAL_RE = /^-?(?:\d+\.\d*|\.\d+|\d+\.\d+)$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?$/;
/** True when a raw cell value carries no information (missing/blank). */
function isBlank(value) {
    if (value === null || value === undefined) {
        return true;
    }
    return typeof value === 'string' && value.trim().length === 0;
}
/**
 * Classify a single (non-blank) cell value into a {@link ValueCategory}.
 *
 * Native `boolean`/`number` values (e.g. from an Excel extractor) are honored
 * directly; strings are matched against the integer / decimal / ISO-date /
 * ISO-timestamp / boolean shapes. Anything else is `TEXT`.
 */
function classifyValue(value) {
    if (typeof value === 'boolean') {
        return 'BOOLEAN';
    }
    if (typeof value === 'number') {
        return Number.isInteger(value) ? 'INTEGER' : 'NUMERIC';
    }
    if (typeof value !== 'string') {
        return 'TEXT';
    }
    const s = value.trim();
    const lower = s.toLowerCase();
    if (lower === 'true' || lower === 'false') {
        return 'BOOLEAN';
    }
    if (INTEGER_RE.test(s)) {
        return 'INTEGER';
    }
    if (DECIMAL_RE.test(s)) {
        return 'NUMERIC';
    }
    if (TIMESTAMP_RE.test(s)) {
        return 'TIMESTAMP';
    }
    if (DATE_RE.test(s)) {
        return 'DATE';
    }
    return 'TEXT';
}
/**
 * Infer one supported `DataType` for a field from its sample values
 * (Requirement 10.3).
 *
 * Blank values are ignored. A field with no informative values defaults to
 * `TEXT` (the most permissive supported type). When every informative value
 * shares a category that category wins; mixed-but-compatible categories widen
 * (INTEGER + NUMERIC → NUMERIC; DATE + TIMESTAMP → TIMESTAMP); any other mix
 * falls back to `TEXT`.
 */
export function inferFieldType(values) {
    const categories = new Set();
    for (const value of values) {
        if (isBlank(value)) {
            continue;
        }
        categories.add(classifyValue(value));
    }
    if (categories.size === 0) {
        return 'TEXT';
    }
    if (categories.size === 1) {
        return [...categories][0];
    }
    // Compatible widenings of exactly two categories.
    if (categories.size === 2) {
        if (categories.has('INTEGER') && categories.has('NUMERIC')) {
            return 'NUMERIC';
        }
        if (categories.has('DATE') && categories.has('TIMESTAMP')) {
            return 'TIMESTAMP';
        }
    }
    // Any other mixture is heterogeneous: fall back to TEXT.
    return 'TEXT';
}
// ---------------------------------------------------------------------------
// Repeating field-group detection (Requirement 10.2 / Property 41)
// ---------------------------------------------------------------------------
/**
 * A sentinel marking a blank cell in a partition signature, kept distinct from
 * the empty string so a present `""` and a missing value are not conflated.
 */
const BLANK_TOKEN = '\u0000blank';
/** Canonicalize a cell value to a string for value-equality comparison. */
function canonicalCell(value) {
    if (isBlank(value)) {
        return BLANK_TOKEN;
    }
    return typeof value === 'string' ? value : String(value);
}
/**
 * The ordered set of field names across all records (union of keys, in
 * first-seen order so the model's column order is stable and reproducible).
 */
export function collectFieldNames(records) {
    const seen = new Set();
    const names = [];
    for (const record of records) {
        for (const key of Object.keys(record)) {
            if (!seen.has(key)) {
                seen.add(key);
                names.push(key);
            }
        }
    }
    return names;
}
/**
 * Compute a column's *partition signature*: the pattern of value-equality
 * across records, independent of the actual values. Records sharing a value in
 * the column receive the same class index, assigned in first-seen order. For
 * example the column `[a, b, a, c, b]` has signature `0,1,0,2,1`.
 *
 * Two columns with the SAME signature induce the identical partition of the
 * rows — they are mutually functionally dependent and therefore "move
 * together", which is the structural fingerprint of fields that belong to one
 * shared sub-entity. The number of distinct classes (`max + 1`) is the count
 * of distinct value-combinations the column takes.
 */
function partitionSignature(records, field) {
    const classOf = new Map();
    const indices = [];
    for (const record of records) {
        const cell = canonicalCell(record[field]);
        let cls = classOf.get(cell);
        if (cls === undefined) {
            cls = classOf.size;
            classOf.set(cell, cls);
        }
        indices.push(cls);
    }
    return { signature: indices.join(','), distinctClasses: classOf.size };
}
/**
 * Detect repeating field groups (Requirement 10.2, Property 41).
 *
 * Heuristic — functional-dependency clustering by partition signature:
 *  1. Group fields that induce the identical row partition (same signature).
 *     Such fields covary perfectly, so they describe one shared sub-entity.
 *  2. Keep a cluster only when it (a) has two or more fields AND (b) actually
 *     *repeats* — i.e. its number of distinct value-combinations is fewer than
 *     the record count, so at least one combination is shared by two or more
 *     records. A cluster of two all-distinct (key-like) fields is therefore
 *     NOT extracted, because nothing repeats.
 *
 * This deterministically detects any planted group whose 2+ fields share
 * repeated value-combinations across 2+ rows (the Property 41 generator shape:
 * each row references one of several reused sub-entity instances).
 */
export function detectRepeatingGroups(records, fieldNames) {
    const recordCount = records.length;
    // Cluster fields by their partition signature, preserving column order.
    const clusters = new Map();
    for (const field of fieldNames) {
        const { signature, distinctClasses } = partitionSignature(records, field);
        const existing = clusters.get(signature);
        if (existing === undefined) {
            clusters.set(signature, { fields: [field], distinctClasses });
        }
        else {
            existing.fields.push(field);
        }
    }
    const groups = [];
    for (const cluster of clusters.values()) {
        const repeats = cluster.distinctClasses < recordCount;
        if (cluster.fields.length >= 2 && repeats) {
            groups.push({ fields: cluster.fields });
        }
    }
    return groups;
}
// ---------------------------------------------------------------------------
// Candidate-model assembly
// ---------------------------------------------------------------------------
/** Tokenize a field name into lowercase word tokens (snake/kebab/camel/space). */
function tokenize(name) {
    return name
        .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
        .split(/[^a-zA-Z0-9]+/)
        .filter((t) => t.length > 0)
        .map((t) => t.toLowerCase());
}
/**
 * Derive a human-readable entity name for an extracted group from the longest
 * shared leading token of its field names (e.g. `facultyName`, `facultyDept`
 * → `faculty`). Falls back to the first field name when there is no shared
 * prefix.
 */
function deriveGroupName(fields) {
    const tokenLists = fields.map(tokenize);
    const shared = [];
    const first = tokenLists[0] ?? [];
    for (let i = 0; i < first.length; i++) {
        const token = first[i];
        if (tokenLists.every((tokens) => tokens[i] === token)) {
            shared.push(token);
        }
        else {
            break;
        }
    }
    if (shared.length > 0) {
        return shared.join('_');
    }
    return fields[0] ?? 'group';
}
/** Reserve a unique entity name within `taken`, suffixing on collision. */
function uniqueName(base, taken) {
    const seed = base.length > 0 ? base : 'entity';
    if (!taken.has(seed)) {
        taken.add(seed);
        return seed;
    }
    let i = 2;
    while (taken.has(`${seed}_${i}`)) {
        i += 1;
    }
    const name = `${seed}_${i}`;
    taken.add(name);
    return name;
}
/** Build a raw candidate attribute carrying its inferred supported data type. */
function rawAttribute(field, records) {
    const values = records.map((r) => r[field]);
    // The inferred DataType is itself a valid free-form dataType string that
    // `normalizeDataType` maps back onto the same supported type.
    return { name: field, dataType: inferFieldType(values) };
}
/** The fixed name given to the main (per-row) entity of a decomposed table. */
const MAIN_ENTITY_NAME = 'Record';
/**
 * Assemble a `RawCandidateModel` from the records by extracting each repeating
 * group into its own entity and relating it to the main entity.
 *
 * The main entity holds the non-extracted fields; each extracted entity holds
 * its group's fields. A `ONE_TO_MANY` relationship is emitted with the main
 * entity as the dependent (many) source and the extracted entity as the (one)
 * target, so the shared constraint-inference pass places a foreign key from the
 * main entity onto the extracted entity's primary key — exactly as for a
 * prompt-derived model. Primary keys are intentionally omitted so normalization
 * synthesizes a surrogate `id` for every entity.
 *
 * Returns the assembled candidate together with the main entity's name and the
 * field bindings for each extracted group, which the seeding pass uses to load
 * the source rows into the generated backend.
 */
function assembleCandidate(records, fieldNames, groups) {
    const extractedFields = new Set();
    for (const group of groups) {
        for (const field of group.fields) {
            extractedFields.add(field);
        }
    }
    const takenEntityNames = new Set();
    const mainName = uniqueName(MAIN_ENTITY_NAME, takenEntityNames);
    const mainAttributes = fieldNames
        .filter((field) => !extractedFields.has(field))
        .map((field) => rawAttribute(field, records));
    const entities = [
        { name: mainName, attributes: mainAttributes },
    ];
    const relationships = [];
    const groupBindings = [];
    for (const group of groups) {
        const entityName = uniqueName(deriveGroupName(group.fields), takenEntityNames);
        entities.push({
            name: entityName,
            attributes: group.fields.map((field) => rawAttribute(field, records)),
        });
        // Main is the "many" side (one row per source record), the extracted group
        // is the reused "one" side.
        relationships.push({
            source: mainName,
            target: entityName,
            cardinality: 'ONE_TO_MANY',
        });
        groupBindings.push({ entityName, fields: [...group.fields] });
    }
    return { candidate: { entities, relationships }, mainName, groupBindings };
}
/**
 * Coerce a raw cell value to the column's inferred supported type so seeded
 * rows satisfy the same type-sensitive constraints (e.g. numeric RANGE) the
 * CRUD runtime enforces. Blank cells become `undefined` (the column is left
 * absent). Values that cannot be coerced are passed through unchanged.
 */
function coerceToType(value, dataType) {
    if (isBlank(value)) {
        return undefined;
    }
    switch (dataType) {
        case 'INTEGER':
        case 'BIGINT':
        case 'NUMERIC': {
            const n = typeof value === 'number' ? value : Number(String(value).trim());
            return Number.isFinite(n) ? n : value;
        }
        case 'BOOLEAN': {
            if (typeof value === 'boolean') {
                return value;
            }
            const s = String(value).trim().toLowerCase();
            if (s === 'true')
                return true;
            if (s === 'false')
                return false;
            return value;
        }
        default:
            return value;
    }
}
/**
 * Build the seed rows for the enriched model from the original source records.
 *
 * For every extracted group the distinct value-combinations across the records
 * each become one group row with a freshly generated surrogate `id`. Each main
 * row carries the non-extracted fields plus, for every group, the foreign-key
 * column linking it to the matching group row — the FK column name and the
 * group/main primary-key columns are read back from the enriched model so the
 * seed always matches whatever names normalization + constraint inference
 * produced.
 */
function buildSeed(model, records, fieldNames, assembly) {
    const seed = new Map();
    const mainEntity = model.entities.find((e) => e.name === assembly.mainName);
    if (mainEntity === undefined) {
        return seed;
    }
    const mainPk = mainEntity.primaryKey[0];
    // Inferred type per source field, used to coerce cell values on seed.
    const fieldType = new Map();
    for (const field of fieldNames) {
        fieldType.set(field, inferFieldType(records.map((r) => r[field])));
    }
    const groupPlans = [];
    for (const binding of assembly.groupBindings) {
        const groupEntity = model.entities.find((e) => e.name === binding.entityName);
        if (groupEntity === undefined) {
            continue;
        }
        // The FK column on the main entity that references this group entity.
        const fkAttr = mainEntity.attributes.find((a) => a.constraints.some((c) => c.kind === 'FOREIGN_KEY' && c.references.entity === binding.entityName));
        if (fkAttr === undefined) {
            continue;
        }
        groupPlans.push({
            fields: binding.fields,
            pkColumn: groupEntity.primaryKey[0],
            fkColumn: fkAttr.name,
            rowBySig: new Map(),
            rows: [],
        });
    }
    const extractedFields = new Set();
    for (const plan of groupPlans) {
        for (const field of plan.fields) {
            extractedFields.add(field);
        }
    }
    const mainFields = fieldNames.filter((f) => !extractedFields.has(f));
    const mainRows = [];
    for (const record of records) {
        const mainRow = { [mainPk]: randomUUID() };
        for (const field of mainFields) {
            const v = coerceToType(record[field], fieldType.get(field) ?? 'TEXT');
            if (v !== undefined) {
                mainRow[field] = v;
            }
        }
        for (const plan of groupPlans) {
            const signature = plan.fields.map((f) => canonicalCell(record[f])).join('\u0001');
            let id = plan.rowBySig.get(signature);
            if (id === undefined) {
                id = randomUUID();
                plan.rowBySig.set(signature, id);
                const groupRow = { [plan.pkColumn]: id };
                for (const field of plan.fields) {
                    const v = coerceToType(record[field], fieldType.get(field) ?? 'TEXT');
                    if (v !== undefined) {
                        groupRow[field] = v;
                    }
                }
                plan.rows.push(groupRow);
            }
            mainRow[plan.fkColumn] = id;
        }
        mainRows.push(mainRow);
    }
    // Publish group rows (referenced entities) first, then the main rows, so the
    // seeding pass inserts FK targets before the rows that reference them.
    for (let i = 0; i < groupPlans.length; i++) {
        seed.set(assembly.groupBindings[i].entityName, groupPlans[i].rows);
    }
    seed.set(assembly.mainName, mainRows);
    return seed;
}
/**
 * Decompose flat extracted records into a well-formed `DataModel` **and** the
 * seed rows that load the source data into the generated backend.
 *
 * Same decomposition + normalization + constraint-inference + invariant
 * validation pipeline as {@link inferModelFromRecords}; additionally it derives
 * a {@link SeedData} map so the document's actual rows populate the entities
 * (each repeating group's distinct tuples become group rows; every source row
 * becomes a main row linked to its group rows by the inferred foreign keys).
 * Fails closed with `NO_DATA_MODEL` exactly as the model-only path does.
 */
export function inferModelAndSeedFromRecords(records) {
    if (records.length === 0) {
        return err({
            kind: 'NO_DATA_MODEL',
            message: 'No Data_Model could be derived from the document: no records were provided.',
        });
    }
    const fieldNames = collectFieldNames(records);
    if (fieldNames.length === 0) {
        return err({
            kind: 'NO_DATA_MODEL',
            message: 'No Data_Model could be derived from the document: the records contain no named fields.',
        });
    }
    const groups = detectRepeatingGroups(records, fieldNames);
    const assembly = assembleCandidate(records, fieldNames, groups);
    // Same deterministic pipeline as inferFromPrompt: structural normalization,
    // then semantic + relational-FK constraint inference, then a defensive
    // invariant re-validation so the document-derived model is well-formed.
    const normalized = normalizeCandidate(assembly.candidate);
    if (isErr(normalized)) {
        return normalized;
    }
    const enriched = inferConstraints(normalized.value, assembly.candidate);
    const validated = validateDataModel(enriched);
    if (isErr(validated)) {
        return err({
            kind: 'NO_DATA_MODEL',
            message: `No valid Data_Model could be produced from the document: decomposition violated invariants (${validated.error
                .map((v) => v.invariant)
                .join(', ')}).`,
        });
    }
    const seed = buildSeed(enriched, records, fieldNames, assembly);
    return ok({ model: enriched, seed });
}
/**
 * Decompose flat extracted records into a well-formed `DataModel`.
 *
 * Fails closed with `NO_DATA_MODEL` when no entity can be derived — an empty
 * record list or records with no named fields (Req 1.8 discipline applied to
 * the document path). Otherwise it assembles a raw candidate (splitting out
 * repeating field groups, Req 10.2) and runs it through the same
 * normalization + constraint-inference + invariant-validation pipeline as the
 * prompt path, so the result satisfies invariants I1–I6 and is structurally
 * identical in shape to a prompt-derived model (Req 10.3).
 *
 * This is the model-only projection of {@link inferModelAndSeedFromRecords};
 * it discards the derived seed rows.
 */
export function inferModelFromRecords(records) {
    const result = inferModelAndSeedFromRecords(records);
    if (isErr(result)) {
        return result;
    }
    return ok(result.value.model);
}
/** True when `column` looks like a foreign key by naming (`x_id` / `xId`). */
function looksLikeForeignKeyName(column) {
    if (/^id$/i.test(column)) {
        return false;
    }
    return /(_id|Id)$/.test(column);
}
/** Strip a trailing `_id`/`Id` to recover the referenced base name. */
function foreignKeyBase(column) {
    return column.replace(/(_id|Id)$/, '');
}
/** Find an entity whose name matches `base` (exact / singular / plural, ci). */
function matchEntityName(base, entityNames) {
    const b = base.toLowerCase();
    return entityNames.find((name) => {
        const n = name.toLowerCase();
        return n === b || n === `${b}s` || `${n}s` === b || n === `${b}es`;
    });
}
/**
 * Build a `DataModel` + {@link SeedData} from a multi-sheet workbook
 * (Requirement 10, multi-sheet extension). Each sheet becomes its own entity
 * (NOT decomposed — a workbook's sheets are already separate tables); columns
 * named like foreign keys (`customer_id`) that match another sheet's name are
 * wired as `FOREIGN_KEY` constraints + `ONE_TO_MANY` relationships, so the
 * cross-sheet relational structure is recovered. The source rows are seeded,
 * preserving each sheet's own id/foreign-key values so the links resolve.
 *
 * Falls back to {@link inferModelAndSeedFromRecords} (single-sheet
 * repeating-group decomposition) when only one sheet has data.
 */
export function inferModelAndSeedFromSheets(sheets) {
    const usable = sheets.filter((s) => s.records.length > 0);
    if (usable.length === 0) {
        return err({
            kind: 'NO_DATA_MODEL',
            message: 'No Data_Model could be derived from the document: every sheet was empty.',
        });
    }
    if (usable.length === 1) {
        return inferModelAndSeedFromRecords(usable[0].records);
    }
    // Reserve a unique entity name per sheet.
    const takenEntityNames = new Set();
    const sheetEntities = usable.map((sheet) => {
        const name = uniqueName(sheet.name.trim() || 'Sheet', takenEntityNames);
        const fieldNames = collectFieldNames(sheet.records);
        return { name, fieldNames, records: sheet.records };
    });
    const entityNames = sheetEntities.map((e) => e.name);
    // Build entities with inferred types + a primary key (existing `id` or a
    // synthesized surrogate). Foreign-key constraints are attached to columns
    // whose name matches another sheet.
    const entities = [];
    const relationships = [];
    const synthesizedPk = new Map(); // entity -> synthesized pk col
    for (const se of sheetEntities) {
        const hasId = se.fieldNames.some((f) => f.toLowerCase() === 'id');
        const pkColumn = hasId
            ? se.fieldNames.find((f) => f.toLowerCase() === 'id')
            : 'id';
        if (!hasId) {
            synthesizedPk.set(se.name, pkColumn);
        }
        const attributes = [];
        if (!hasId) {
            attributes.push({ name: pkColumn, dataType: 'UUID', constraints: [{ kind: 'NOT_NULL' }] });
        }
        for (const field of se.fieldNames) {
            const dataType = inferFieldType(se.records.map((r) => r[field]));
            const constraints = [];
            if (field === pkColumn) {
                constraints.push({ kind: 'NOT_NULL' });
            }
            else if (looksLikeForeignKeyName(field)) {
                const target = matchEntityName(foreignKeyBase(field), entityNames);
                if (target !== undefined && target !== se.name) {
                    constraints.push({
                        kind: 'FOREIGN_KEY',
                        references: { entity: target, attribute: 'id' },
                    });
                    relationships.push({ source: se.name, target, cardinality: 'ONE_TO_MANY' });
                }
            }
            attributes.push({ name: field, dataType, constraints });
        }
        entities.push({
            name: se.name,
            attributes,
            primaryKey: [pkColumn],
            isJoinEntity: false,
        });
    }
    // Layer semantic constraints (email/unique/range/not-null) WITHOUT synthesizing
    // foreign-key columns (relationships are applied afterward), so the existing
    // FK columns are used as-is rather than duplicated.
    const enriched = inferConstraints({ entities, relationships: [] });
    const model = { entities: enriched.entities, relationships };
    const validated = validateDataModel(model);
    if (isErr(validated)) {
        return err({
            kind: 'NO_DATA_MODEL',
            message: `No valid Data_Model could be produced from the workbook: ${validated.error
                .map((v) => v.invariant)
                .join(', ')}.`,
        });
    }
    // Seed: one row per source row, coerced to the column types, preserving each
    // sheet's id and foreign-key values so cross-sheet links resolve. Parent
    // entities (FK targets) are emitted before the entities that reference them.
    const order = topoOrder(model);
    const byName = new Map(model.entities.map((e) => [e.name, e]));
    const seed = new Map();
    for (const entityName of order) {
        const entity = byName.get(entityName);
        const se = sheetEntities.find((s) => s.name === entityName);
        if (entity === undefined || se === undefined) {
            continue;
        }
        const synthPk = synthesizedPk.get(entityName);
        const typeOf = new Map(entity.attributes.map((a) => [a.name, a.dataType]));
        const rows = se.records.map((record) => {
            const row = {};
            if (synthPk !== undefined) {
                row[synthPk] = randomUUID();
            }
            for (const field of se.fieldNames) {
                const v = coerceToType(record[field], typeOf.get(field) ?? 'TEXT');
                if (v !== undefined) {
                    row[field] = v;
                }
            }
            return row;
        });
        seed.set(entityName, rows);
    }
    return ok({ model, seed });
}
/** Order entities so FK targets precede the entities that reference them. */
function topoOrder(model) {
    const names = model.entities.map((e) => e.name);
    const deps = new Map();
    for (const n of names)
        deps.set(n, new Set());
    for (const rel of model.relationships) {
        if (deps.has(rel.source) && names.includes(rel.target) && rel.source !== rel.target) {
            deps.get(rel.source).add(rel.target);
        }
    }
    const ordered = [];
    const placed = new Set();
    let progress = true;
    while (ordered.length < names.length && progress) {
        progress = false;
        for (const n of names) {
            if (placed.has(n))
                continue;
            if ([...deps.get(n)].every((d) => placed.has(d))) {
                ordered.push(n);
                placed.add(n);
                progress = true;
            }
        }
    }
    for (const n of names)
        if (!placed.has(n))
            ordered.push(n);
    return ordered;
}
//# sourceMappingURL=records.js.map