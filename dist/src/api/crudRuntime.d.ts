/**
 * Generated CRUD runtime (task 7.2).
 *
 * The runtime counterpart to {@link ../api/apiGenerator.ts}: where the
 * API_Generator describes *what endpoints exist* for each entity, this module
 * implements *how those endpoints behave* against a backing store. Like the
 * other projections of the Data_Model, an {@link EntityCrud} is derived purely
 * from an entity's descriptor (its primary key + attribute constraints), so its
 * behavior is deterministic and directly testable.
 *
 * Responsibilities (Req 5.2–5.9):
 * - **create** — persist a record satisfying every Data_Model constraint and
 *   return it with its assigned primary key (Req 5.2).
 * - **read** — return the record for an existing primary key (Req 5.3).
 * - **update** — persist an updated record satisfying constraints for an
 *   existing primary key and return it (Req 5.4).
 * - **delete** — remove an existing record by primary key and return a deletion
 *   confirmation (Req 5.5).
 * - **list** — default page size 25 ordered by primary key ascending (Req 5.8);
 *   reject a page size outside the inclusive range [1, 100] with a validation
 *   error (Req 5.9).
 * - **validation** — reject any payload that violates a constraint *without
 *   persisting* and return a validation error identifying **each** violated
 *   constraint (Req 5.6).
 * - **not-found** — read / update / delete on a non-existent primary key
 *   returns a not-found error and changes no stored data (Req 5.7).
 *
 * ## Backing store
 *
 * The store is abstracted behind {@link RecordStore} (an in-memory Map-per-
 * entity implementation is provided by {@link createInMemoryStore}) so it can
 * be injected for testing. Records are plain `Record<string, unknown>` maps and
 * are addressed by a stable serialization of their primary-key column values,
 * which supports composite primary keys.
 *
 * ## Primary-key assignment rule (Req 5.2)
 *
 * On create, each primary-key column is taken from the payload when present.
 * For a **single-column** primary key whose attribute type is `UUID`, a missing
 * value is auto-assigned a freshly generated UUID (a surrogate key). All other
 * missing primary-key values are left absent and therefore caught by the
 * not-null validation that every primary-key column carries — the runtime never
 * fabricates values for caller-supplied keys.
 *
 * ## Constraint validation
 *
 * Validation is derived from each attribute's `constraints` and collects *all*
 * violations before returning (Req 5.6):
 * - `NOT_NULL` — value must be present and non-empty (missing, `null`, or `''`
 *   is a violation, per Req 2.2 wording).
 * - `UNIQUE` (and primary-key uniqueness) — no *other* record of the entity may
 *   hold the same non-null value (Req 2.1).
 * - `FORMAT: 'EMAIL'` — delegates to {@link isValidEmail} (Req 2.3).
 * - `RANGE` — a present value must be numeric and `>= min` (and `<= max` when a
 *   max is set) (Req 2.4).
 * - `FOREIGN_KEY` — referential existence is checked *lightly*: only when the
 *   referenced entity is registered in the same {@link EntityCrudSet} and its
 *   primary key is the single referenced column. Otherwise the check is skipped
 *   (documented light scope for the in-memory runtime).
 */
import type { AttributeConstraint, DataModel } from '../model/types.js';
import { type Result } from '../model/result.js';
import { type ApiSurface, type EntityApiDescriptor } from './apiGenerator.js';
/** A single stored record: a dialect-independent map of column name to value. */
export type EntityRecord = Record<string, unknown>;
/**
 * A primary-key value used to address a single record. Accepts either a scalar
 * (convenient for single-column keys) or a `{ column: value }` map (required
 * for composite keys).
 */
export type PrimaryKeyInput = EntityRecord | string | number | boolean;
/** Default list page size when none is specified (Req 5.8). */
export declare const DEFAULT_PAGE_SIZE = 25;
/** Minimum permitted list page size, inclusive (Req 5.9). */
export declare const MIN_PAGE_SIZE = 1;
/** Maximum permitted list page size, inclusive (Req 5.9). */
export declare const MAX_PAGE_SIZE = 100;
/** A request for one page of a `list` result. `page` is 1-based. */
export type PageRequest = {
    /** 1-based page index. Defaults to 1; values < 1 are treated as 1. */
    page?: number;
    /** Page size; must be within [1, 100] or the request is rejected (Req 5.9). */
    size?: number;
};
/** One page of `list` results (Req 5.8). */
export type Page<T extends EntityRecord = EntityRecord> = {
    /** The records for the requested page, ordered by primary key ascending. */
    records: T[];
    /** The 1-based page index returned. */
    page: number;
    /** The effective page size used. */
    pageSize: number;
    /** Total number of records in the entity across all pages. */
    total: number;
};
/** Confirmation that a record was deleted (Req 5.5). */
export type DeleteConfirmation = {
    deleted: true;
    entityName: string;
    /** The primary-key values of the removed record. */
    primaryKey: EntityRecord;
};
/** A single violated constraint, identifying the attribute and constraint kind. */
export type ConstraintViolation = {
    /** The attribute whose constraint was violated. */
    attribute: string;
    /** The kind of constraint that was violated. */
    kind: AttributeConstraint['kind'];
    /** Human-readable description of the violation. */
    message: string;
};
/**
 * A payload rejected for violating one or more constraints, or a list request
 * with an out-of-range page size. Carries *every* violated constraint (Req 5.6,
 * 5.9). No change is persisted when this is returned.
 */
export type ValidationError = {
    kind: 'VALIDATION_ERROR';
    message: string;
    violations: ConstraintViolation[];
};
/** A read/update/delete addressed a primary key that does not exist (Req 5.7). */
export type NotFoundError = {
    kind: 'NOT_FOUND';
    message: string;
    entityName: string;
    /** The primary-key values that were not found. */
    primaryKey: EntityRecord;
};
/**
 * The persistence boundary for the CRUD runtime. Records are keyed per entity
 * by a stable serialization of their primary-key column values
 * (see {@link serializePrimaryKey}). Injectable so tests can supply a fake; the
 * default in-memory implementation is {@link createInMemoryStore}.
 */
export interface RecordStore {
    /** Return the record for `key` within `entityName`, or undefined. */
    get(entityName: string, key: string): EntityRecord | undefined;
    /** Whether a record exists for `key` within `entityName`. */
    has(entityName: string, key: string): boolean;
    /** Insert or replace the record for `key` within `entityName`. */
    set(entityName: string, key: string, record: EntityRecord): void;
    /** Remove the record for `key`; returns true if a record was removed. */
    delete(entityName: string, key: string): boolean;
    /** All `(key, record)` pairs currently stored for `entityName`. */
    entries(entityName: string): {
        key: string;
        record: EntityRecord;
    }[];
}
/**
 * An in-memory {@link RecordStore} backed by a `Map` per entity keyed by the
 * serialized primary key. Suitable for tests and the local development runtime.
 */
export declare function createInMemoryStore(): RecordStore;
/**
 * Resolves whether a foreign-key reference target exists. Returns `true` /
 * `false` when the reference can be checked, or `undefined` when the check is
 * out of scope and should be skipped (e.g. the referenced entity is not
 * registered, or its primary key is composite).
 */
type ForeignKeyResolver = (entity: string, attribute: string, value: unknown) => boolean | undefined;
/**
 * Per-entity CRUD operations against a {@link RecordStore}, derived from an
 * {@link EntityApiDescriptor}. Construct directly for a standalone entity, or
 * via {@link buildCrudSet} to get cross-entity foreign-key existence checks.
 */
export declare class EntityCrud {
    readonly entityName: string;
    readonly primaryKey: string[];
    private readonly attributes;
    private readonly store;
    private readonly resolveForeignKey;
    constructor(descriptor: EntityApiDescriptor, store: RecordStore, resolveForeignKey?: ForeignKeyResolver);
    /**
     * Persist a record that satisfies every constraint and return it with its
     * assigned primary key (Req 5.2). Auto-assigns a UUID for a missing
     * single-column UUID primary key (see the module's PK-assignment rule). On
     * any constraint violation, persists nothing and returns a validation error
     * naming every violated constraint (Req 5.6).
     */
    create(payload: EntityRecord): Result<EntityRecord, ValidationError>;
    /** Return the record for an existing primary key (Req 5.3, 5.7). */
    read(pk: PrimaryKeyInput): Result<EntityRecord, NotFoundError>;
    /**
     * Persist an updated record for an existing primary key and return it
     * (Req 5.4). The primary key is fixed to the addressed key, so an update
     * never moves a record. Returns not-found for an absent key (Req 5.7) and a
     * validation error — persisting nothing — for any constraint violation
     * (Req 5.6).
     */
    update(pk: PrimaryKeyInput, payload: EntityRecord): Result<EntityRecord, ValidationError | NotFoundError>;
    /** Remove an existing record by primary key and confirm (Req 5.5, 5.7). */
    delete(pk: PrimaryKeyInput): Result<DeleteConfirmation, NotFoundError>;
    /**
     * Return a page of records ordered by primary key ascending (Req 5.8).
     * Defaults to page 1 with a size of 25. Rejects a requested size outside the
     * inclusive range [1, 100] with a validation error (Req 5.9).
     */
    list(request?: PageRequest): Result<Page, ValidationError>;
    /**
     * Auto-assign a UUID to a missing single-column UUID primary key (the
     * surrogate-key rule). Composite keys and non-UUID keys are never fabricated.
     */
    private assignSurrogateKey;
    /**
     * Collect every constraint violation in `record`. `selfKey` is the serialized
     * key of the record being updated (excluded from uniqueness checks) or `null`
     * on create.
     */
    private validate;
    /** Append a violation for a single constraint, if `value` violates it. */
    private checkConstraint;
    /** Whether another record (not `selfKey`) holds `value` for `attributeName`. */
    private duplicateExists;
    private validationError;
    private notFound;
}
/**
 * The complete CRUD runtime for a Data_Model: one {@link EntityCrud} per
 * entity, sharing a single {@link RecordStore}. Because every entity is
 * registered here, sibling entities can resolve each other's foreign-key
 * references for the light referential-existence check.
 */
export declare class EntityCrudSet {
    private readonly cruds;
    /** The shared store backing every entity's records. */
    readonly store: RecordStore;
    constructor(surface: ApiSurface, store: RecordStore);
    /** The CRUD operations for `entityName`, or undefined if not in the model. */
    get(entityName: string): EntityCrud | undefined;
    /** The names of every entity served by this runtime, in model order. */
    entityNames(): string[];
}
/**
 * Build the CRUD runtime for a Data_Model. Generates the API surface from the
 * model and wires every entity to a shared store (an in-memory store is created
 * when none is supplied), enabling cross-entity foreign-key checks.
 */
export declare function buildCrudSet(model: DataModel, store?: RecordStore): EntityCrudSet;
/**
 * Build the CRUD runtime directly from a pre-generated {@link ApiSurface}, for
 * callers that already hold one. Uses an in-memory store when none is supplied.
 */
export declare function crudSetFromSurface(surface: ApiSurface, store?: RecordStore): EntityCrudSet;
export {};
