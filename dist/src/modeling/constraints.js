/**
 * Constraint inference (task 2.3): layers `AttributeConstraint`s onto a
 * *structurally* normalized `DataModel` (the output of `normalizeCandidate`).
 *
 * `normalize.ts` guarantees the structural invariants I1–I6 (one PK per
 * entity, supported data types, valid cardinality, materialized M:N join
 * entities with their foreign keys). This module is responsible for the
 * *semantic* constraints of Requirement 2:
 *
 *  - UNIQUE (Req 2.1)        — from the raw candidate's advisory `unique` hint
 *                              and uniquely-identifying name heuristics.
 *  - NOT_NULL (Req 2.2)      — from the advisory `required` hint and the rule
 *                              that primary-key columns are not-null.
 *  - FORMAT EMAIL (Req 2.3)  — for attributes whose name denotes an email
 *                              address. The accept/reject rule is implemented
 *                              by {@link isValidEmail} (it backs Property 7 and
 *                              is reused by the API validation layer).
 *  - RANGE min 0 (Req 2.4)   — for numeric count/quantity/age/price-style
 *                              attributes with a natural lower bound.
 *  - FOREIGN_KEY (Req 2.5)   — for ordinary (non-join) relationships, a foreign
 *                              key on the dependent entity referencing the
 *                              related entity's primary key. Join-entity FKs
 *                              are already produced by `normalize.ts` and are
 *                              not duplicated here.
 *  - needsReview (Req 2.7)   — low-confidence attributes are flagged for
 *                              builder review rather than having a constraint
 *                              guessed for them.
 *
 * The module is a pure function of its inputs: it returns a new `DataModel`
 * and never mutates the model handed in. The result still satisfies the
 * Data_Model invariants I1–I6.
 */
// ---------------------------------------------------------------------------
// Email format predicate (Requirement 2.3 / Property 7)
// ---------------------------------------------------------------------------
/**
 * The email-format predicate backing the `FORMAT: 'EMAIL'` constraint
 * (Requirement 2.3, Property 7). It is the single source of truth for what
 * counts as a well-formed email and is reused by the API validation layer.
 *
 * A value is accepted **if and only if** it contains exactly one `"@"`
 * separating a non-empty local part from a domain part that contains at least
 * one `"."`. Every other value is rejected.
 *
 * Note: this is intentionally the literal rule from Requirement 2.3, not a
 * fuller RFC 5322 grammar — matching the requirement exactly is what Property 7
 * verifies.
 */
export function isValidEmail(value) {
    if (typeof value !== 'string') {
        return false;
    }
    const firstAt = value.indexOf('@');
    // Must contain an "@" ...
    if (firstAt === -1) {
        return false;
    }
    // ... and exactly one of them.
    if (value.indexOf('@', firstAt + 1) !== -1) {
        return false;
    }
    const localPart = value.slice(0, firstAt);
    const domainPart = value.slice(firstAt + 1);
    // Non-empty local part separated from a domain that contains at least one ".".
    if (localPart.length === 0) {
        return false;
    }
    return domainPart.includes('.');
}
// ---------------------------------------------------------------------------
// Name-heuristic vocabularies (documented decisions)
// ---------------------------------------------------------------------------
/** Numeric `DataType`s eligible for a natural-lower-bound RANGE constraint. */
const NUMERIC_TYPES = new Set([
    'INTEGER', 'BIGINT', 'NUMERIC',
]);
/** Text-ish `DataType`s eligible for an EMAIL format constraint. */
const TEXTUAL_TYPES = new Set([
    'TEXT', 'VARCHAR',
]);
/**
 * Name tokens that strongly imply an attribute uniquely identifies a record,
 * so a UNIQUE constraint is applied confidently (Req 2.1).
 */
const UNIQUE_TOKENS = new Set([
    'email', 'username', 'slug', 'sku', 'isbn', 'barcode', 'ssn', 'handle',
]);
/**
 * Numeric attribute name tokens with a natural lower bound of 0
 * (Req 2.4: count, quantity, age, price, plus close synonyms).
 */
const LOWER_BOUND_ZERO_TOKENS = new Set([
    'count', 'quantity', 'qty', 'age', 'price', 'cost', 'amount', 'stock',
    'inventory',
]);
/**
 * Name tokens that *weakly* hint an attribute might be unique (an identifier
 * or code) but are not conclusive. When present without a confident signal,
 * the attribute is flagged `needsReview` rather than guessing UNIQUE (Req 2.7).
 */
const AMBIGUOUS_IDENTIFIER_TOKENS = new Set([
    'code', 'number', 'identifier', 'key',
]);
// ---------------------------------------------------------------------------
// Small pure helpers
// ---------------------------------------------------------------------------
/**
 * Split an attribute name into lowercase word tokens, handling snake_case,
 * kebab-case, spaces, and camelCase. Token matching (rather than substring
 * matching) avoids false positives like "discount" matching "count" or
 * "account" matching "count".
 */
function tokenize(name) {
    return name
        .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
        .split(/[^a-zA-Z0-9]+/)
        .filter((t) => t.length > 0)
        .map((t) => t.toLowerCase());
}
function hasAnyToken(tokens, vocab) {
    return tokens.some((t) => vocab.has(t));
}
function hasConstraint(constraints, kind) {
    return constraints.some((c) => c.kind === kind);
}
function isForeignKey(attribute) {
    return hasConstraint(attribute.constraints, 'FOREIGN_KEY');
}
/** Build entity -> attribute -> advisory hints lookup from the raw candidate. */
function buildHintLookup(raw) {
    const byEntity = new Map();
    if (!raw || !Array.isArray(raw.entities)) {
        return byEntity;
    }
    for (const rawEntity of raw.entities) {
        const entityName = typeof rawEntity?.name === 'string' ? rawEntity.name.trim() : '';
        if (entityName.length === 0) {
            continue;
        }
        const attrs = new Map();
        for (const rawAttr of rawEntity.attributes ?? []) {
            const attrName = typeof rawAttr?.name === 'string' ? rawAttr.name.trim() : '';
            if (attrName.length > 0 && !attrs.has(attrName)) {
                attrs.set(attrName, rawAttr);
            }
        }
        byEntity.set(entityName, attrs);
    }
    return byEntity;
}
// ---------------------------------------------------------------------------
// Per-attribute constraint inference
// ---------------------------------------------------------------------------
/**
 * Infer the semantic constraints for a single attribute and decide whether it
 * needs builder review. Returns a fresh `Attribute`; the input is never
 * mutated.
 *
 * Confidence model (Req 2.7): a constraint is applied only on a *confident*
 * signal — an explicit advisory hint, membership in the primary key, or a
 * strong name match. A merely *ambiguous* identifier-ish name (e.g. "code",
 * "number") applies nothing and instead flags `needsReview` so the builder can
 * decide, rather than the engine guessing.
 */
function inferAttributeConstraints(attribute, isPrimaryKey, isJoinEntity, hint) {
    // Start from the structural constraints already present (e.g. join-entity
    // foreign keys produced by normalize.ts), without duplicating them.
    const constraints = [...attribute.constraints];
    const tokens = tokenize(attribute.name);
    const alreadyForeignKey = isForeignKey(attribute);
    let needsReview = attribute.needsReview === true;
    const addUnique = () => {
        if (!hasConstraint(constraints, 'UNIQUE')) {
            constraints.push({ kind: 'UNIQUE' });
        }
    };
    const addNotNull = () => {
        if (!hasConstraint(constraints, 'NOT_NULL')) {
            constraints.push({ kind: 'NOT_NULL' });
        }
    };
    // --- NOT_NULL (Req 2.2) -------------------------------------------------
    // Primary-key columns are always not-null; otherwise honor the advisory
    // `required` hint.
    if (isPrimaryKey || hint?.required === true) {
        addNotNull();
    }
    // Join-entity columns are purely structural foreign keys: skip the
    // name-based semantic heuristics (email/range/unique/review) for them.
    if (isJoinEntity) {
        return { ...attribute, constraints, needsReview };
    }
    // --- UNIQUE (Req 2.1) ---------------------------------------------------
    // A confident unique signal is the advisory hint or a strong identifying
    // name. Primary-key columns are already unique by virtue of being the PK, so
    // no redundant UNIQUE is added for them.
    const confidentUnique = hint?.unique === true || hasAnyToken(tokens, UNIQUE_TOKENS);
    if (confidentUnique && !isPrimaryKey) {
        addUnique();
    }
    // --- FORMAT: EMAIL (Req 2.3) -------------------------------------------
    // Applied to textual attributes whose name contains an "email" token.
    if (TEXTUAL_TYPES.has(attribute.dataType) &&
        tokens.includes('email') &&
        !hasConstraint(constraints, 'FORMAT')) {
        constraints.push({ kind: 'FORMAT', format: 'EMAIL' });
    }
    // --- RANGE min 0 (Req 2.4) ---------------------------------------------
    // Applied to numeric attributes with a natural lower bound of zero.
    if (NUMERIC_TYPES.has(attribute.dataType) &&
        hasAnyToken(tokens, LOWER_BOUND_ZERO_TOKENS) &&
        !hasConstraint(constraints, 'RANGE')) {
        constraints.push({ kind: 'RANGE', min: 0 });
    }
    // --- needsReview (Req 2.7) ---------------------------------------------
    // If the attribute carries a merely-ambiguous identifier name (e.g. "code",
    // "number") and we did NOT apply a confident unique constraint, leave it
    // unconstrained and flag it for builder review instead of guessing.
    const ambiguousIdentifier = hasAnyToken(tokens, AMBIGUOUS_IDENTIFIER_TOKENS);
    if (ambiguousIdentifier &&
        !confidentUnique &&
        !isPrimaryKey &&
        !alreadyForeignKey) {
        needsReview = true;
    }
    return { ...attribute, constraints, needsReview };
}
// ---------------------------------------------------------------------------
// Relationship foreign keys (Requirement 2.5)
// ---------------------------------------------------------------------------
/** Reserve a unique attribute name within `taken`, suffixing on collision. */
function uniqueAttrName(base, taken) {
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
/**
 * Add foreign-key columns/constraints for ordinary (non-join) relationships
 * (Requirement 2.5). For each `ONE_TO_ONE` / `ONE_TO_MANY` relationship the
 * **source** entity is treated as the dependent entity and receives one FK
 * column per primary-key attribute of the **target** entity, referencing that
 * primary key. For `ONE_TO_ONE`, the FK column is also marked UNIQUE so the
 * one-to-one cardinality is enforced.
 *
 * `MANY_TO_MANY` relationships are skipped: their foreign keys live on the
 * join entity already materialized by `normalize.ts`, and are not duplicated
 * here.
 *
 * Mutates the entities in `byName` in place (they are fresh clones owned by
 * {@link inferConstraints}).
 */
function addRelationshipForeignKeys(model, byName) {
    for (const rel of model.relationships) {
        if (rel.cardinality === 'MANY_TO_MANY') {
            continue;
        }
        const dependent = byName.get(rel.source);
        const target = byName.get(rel.target);
        if (dependent === undefined || target === undefined) {
            continue;
        }
        const takenAttrNames = new Set(dependent.attributes.map((a) => a.name));
        for (const pkAttrName of target.primaryKey) {
            // Skip if the dependent entity already references this exact PK column
            // (e.g. an FK introduced by a prior relationship between the same pair).
            const alreadyReferenced = dependent.attributes.some((a) => a.constraints.some((c) => c.kind === 'FOREIGN_KEY' &&
                c.references.entity === rel.target &&
                c.references.attribute === pkAttrName));
            if (alreadyReferenced) {
                continue;
            }
            const referenced = target.attributes.find((a) => a.name === pkAttrName);
            const columnName = uniqueAttrName(`${rel.target}_${pkAttrName}`, takenAttrNames);
            const constraints = [
                {
                    kind: 'FOREIGN_KEY',
                    references: { entity: rel.target, attribute: pkAttrName },
                },
            ];
            // One-to-one: the dependent's reference must be unique.
            if (rel.cardinality === 'ONE_TO_ONE') {
                constraints.push({ kind: 'UNIQUE' });
            }
            dependent.attributes.push({
                name: columnName,
                dataType: referenced?.dataType ?? 'UUID',
                constraints,
            });
        }
    }
}
// ---------------------------------------------------------------------------
// Top-level constraint inference
// ---------------------------------------------------------------------------
/**
 * Enrich a structurally-normalized `DataModel` with the semantic constraints
 * of Requirement 2 (unique, not-null, email format, numeric range, and the
 * foreign keys for ordinary relationships), flagging low-confidence attributes
 * for builder review (Req 2.7).
 *
 * Pure: returns a new `DataModel` and does not mutate `model`. The advisory
 * `unique`/`required` hints are read from the original `raw` candidate (by
 * entity/attribute name) when supplied. The result preserves invariants I1–I6.
 */
export function inferConstraints(model, raw) {
    const hints = buildHintLookup(raw);
    // Clone every entity, applying per-attribute constraint inference.
    const entities = model.entities.map((entity) => {
        const pkSet = new Set(entity.primaryKey);
        const entityHints = hints.get(entity.name);
        const attributes = entity.attributes.map((attribute) => inferAttributeConstraints(attribute, pkSet.has(attribute.name), entity.isJoinEntity, entityHints?.get(attribute.name)));
        return { ...entity, attributes };
    });
    const enriched = {
        entities,
        relationships: model.relationships.map((r) => ({ ...r })),
    };
    // Add foreign keys for ordinary relationships (join-entity FKs already exist).
    const byName = new Map(entities.map((e) => [e.name, e]));
    addRelationshipForeignKeys(enriched, byName);
    return enriched;
}
//# sourceMappingURL=constraints.js.map