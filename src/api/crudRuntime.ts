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

import { randomUUID } from 'node:crypto';
import type {
  Attribute,
  AttributeConstraint,
  DataModel,
} from '../model/types.js';
import { type Result, ok, err } from '../model/result.js';
import { isValidEmail } from '../modeling/constraints.js';
import {
  generate as generateApiSurface,
  type ApiSurface,
  type EntityApiDescriptor,
} from './apiGenerator.js';

// ---------------------------------------------------------------------------
// Record, page, and error types
// ---------------------------------------------------------------------------

/** A single stored record: a dialect-independent map of column name to value. */
export type EntityRecord = Record<string, unknown>;

/**
 * A primary-key value used to address a single record. Accepts either a scalar
 * (convenient for single-column keys) or a `{ column: value }` map (required
 * for composite keys).
 */
export type PrimaryKeyInput = EntityRecord | string | number | boolean;

/** Default list page size when none is specified (Req 5.8). */
export const DEFAULT_PAGE_SIZE = 25;
/** Minimum permitted list page size, inclusive (Req 5.9). */
export const MIN_PAGE_SIZE = 1;
/** Maximum permitted list page size, inclusive (Req 5.9). */
export const MAX_PAGE_SIZE = 100;

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

// ---------------------------------------------------------------------------
// Record store abstraction
// ---------------------------------------------------------------------------

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
  entries(entityName: string): { key: string; record: EntityRecord }[];
}

/**
 * An in-memory {@link RecordStore} backed by a `Map` per entity keyed by the
 * serialized primary key. Suitable for tests and the local development runtime.
 */
export function createInMemoryStore(): RecordStore {
  const tables = new Map<string, Map<string, EntityRecord>>();

  const tableFor = (entityName: string): Map<string, EntityRecord> => {
    let table = tables.get(entityName);
    if (table === undefined) {
      table = new Map<string, EntityRecord>();
      tables.set(entityName, table);
    }
    return table;
  };

  return {
    get(entityName, key) {
      return tableFor(entityName).get(key);
    },
    has(entityName, key) {
      return tableFor(entityName).has(key);
    },
    set(entityName, key, record) {
      tableFor(entityName).set(key, record);
    },
    delete(entityName, key) {
      return tableFor(entityName).delete(key);
    },
    entries(entityName) {
      return [...tableFor(entityName).entries()].map(([key, record]) => ({
        key,
        record,
      }));
    },
  };
}

// ---------------------------------------------------------------------------
// Primary-key helpers
// ---------------------------------------------------------------------------

/**
 * Serialize a record's primary-key values into a stable string key. The values
 * are taken in `primaryKey` column order and JSON-encoded, so composite keys
 * round-trip deterministically and two records collide iff their key columns
 * are equal.
 */
function serializePrimaryKey(
  primaryKey: string[],
  record: EntityRecord,
): string {
  return JSON.stringify(primaryKey.map((column) => record[column] ?? null));
}

/**
 * Normalize a {@link PrimaryKeyInput} into a `{ column: value }` map. A scalar
 * is only valid for a single-column primary key and is bound to that column.
 */
function primaryKeyToRecord(
  primaryKey: string[],
  input: PrimaryKeyInput,
): EntityRecord {
  if (
    typeof input === 'object' &&
    input !== null &&
    !Array.isArray(input)
  ) {
    return input;
  }
  // Scalar input: only meaningful for a single-column primary key.
  if (primaryKey.length === 1) {
    return { [primaryKey[0]]: input };
  }
  // For a composite key a scalar cannot address a record; produce a map that
  // will simply not match any stored key (and is reported as not-found).
  return {};
}

/** Extract just the primary-key columns from a record. */
function pickPrimaryKey(
  primaryKey: string[],
  record: EntityRecord,
): EntityRecord {
  const picked: EntityRecord = {};
  for (const column of primaryKey) {
    picked[column] = record[column];
  }
  return picked;
}

/** Whether every primary-key column has a present (non-nullish) value. */
function hasCompletePrimaryKey(
  primaryKey: string[],
  record: EntityRecord,
): boolean {
  return primaryKey.every(
    (column) => record[column] !== undefined && record[column] !== null,
  );
}

// ---------------------------------------------------------------------------
// Value comparison + ordering
// ---------------------------------------------------------------------------

/** A value is "empty" (for NOT_NULL) when missing, null, or the empty string. */
function isEmptyValue(value: unknown): boolean {
  return value === undefined || value === null || value === '';
}

/**
 * Order two values for primary-key ascending sort. Numbers compare numerically,
 * booleans by false < true, everything else by its string form, so a stable,
 * total ordering exists for any mix of key types.
 */
function compareValues(a: unknown, b: unknown): number {
  if (a === b) {
    return 0;
  }
  if (typeof a === 'number' && typeof b === 'number') {
    return a < b ? -1 : a > b ? 1 : 0;
  }
  if (typeof a === 'boolean' && typeof b === 'boolean') {
    return a === b ? 0 : a ? 1 : -1;
  }
  const as = a === undefined || a === null ? '' : String(a);
  const bs = b === undefined || b === null ? '' : String(b);
  return as < bs ? -1 : as > bs ? 1 : 0;
}

/** Compare two records by their primary-key columns, in order, ascending. */
function comparePrimaryKey(
  primaryKey: string[],
  a: EntityRecord,
  b: EntityRecord,
): number {
  for (const column of primaryKey) {
    const c = compareValues(a[column], b[column]);
    if (c !== 0) {
      return c;
    }
  }
  return 0;
}

// ---------------------------------------------------------------------------
// EntityCrud
// ---------------------------------------------------------------------------

/**
 * Resolves whether a foreign-key reference target exists. Returns `true` /
 * `false` when the reference can be checked, or `undefined` when the check is
 * out of scope and should be skipped (e.g. the referenced entity is not
 * registered, or its primary key is composite).
 */
type ForeignKeyResolver = (
  entity: string,
  attribute: string,
  value: unknown,
) => boolean | undefined;

/**
 * Per-entity CRUD operations against a {@link RecordStore}, derived from an
 * {@link EntityApiDescriptor}. Construct directly for a standalone entity, or
 * via {@link buildCrudSet} to get cross-entity foreign-key existence checks.
 */
export class EntityCrud {
  readonly entityName: string;
  readonly primaryKey: string[];
  private readonly attributes: Attribute[];
  private readonly store: RecordStore;
  private readonly resolveForeignKey: ForeignKeyResolver;

  constructor(
    descriptor: EntityApiDescriptor,
    store: RecordStore,
    resolveForeignKey: ForeignKeyResolver = () => undefined,
  ) {
    this.entityName = descriptor.entityName;
    this.primaryKey = descriptor.primaryKey;
    this.attributes = descriptor.attributes;
    this.store = store;
    this.resolveForeignKey = resolveForeignKey;
  }

  /**
   * Persist a record that satisfies every constraint and return it with its
   * assigned primary key (Req 5.2). Auto-assigns a UUID for a missing
   * single-column UUID primary key (see the module's PK-assignment rule). On
   * any constraint violation, persists nothing and returns a validation error
   * naming every violated constraint (Req 5.6).
   */
  create(payload: EntityRecord): Result<EntityRecord, ValidationError> {
    const record: EntityRecord = { ...payload };
    this.assignSurrogateKey(record);

    const violations = this.validate(record, null);

    // Primary-key uniqueness (Req 2.1 applied to the PK): a complete key must
    // not already exist. An incomplete key is left to NOT_NULL validation.
    if (hasCompletePrimaryKey(this.primaryKey, record)) {
      const key = serializePrimaryKey(this.primaryKey, record);
      if (this.store.has(this.entityName, key)) {
        violations.push({
          attribute: this.primaryKey.join(','),
          kind: 'PRIMARY_KEY',
          message: `A ${this.entityName} record with this primary key already exists`,
        });
      }
    }

    if (violations.length > 0) {
      return err(this.validationError(violations));
    }

    const key = serializePrimaryKey(this.primaryKey, record);
    this.store.set(this.entityName, key, record);
    return ok(record);
  }

  /** Return the record for an existing primary key (Req 5.3, 5.7). */
  read(pk: PrimaryKeyInput): Result<EntityRecord, NotFoundError> {
    const keyRecord = primaryKeyToRecord(this.primaryKey, pk);
    const key = serializePrimaryKey(this.primaryKey, keyRecord);
    const record = this.store.get(this.entityName, key);
    if (record === undefined) {
      return err(this.notFound(keyRecord));
    }
    return ok(record);
  }

  /**
   * Persist an updated record for an existing primary key and return it
   * (Req 5.4). The primary key is fixed to the addressed key, so an update
   * never moves a record. Returns not-found for an absent key (Req 5.7) and a
   * validation error — persisting nothing — for any constraint violation
   * (Req 5.6).
   */
  update(
    pk: PrimaryKeyInput,
    payload: EntityRecord,
  ): Result<EntityRecord, ValidationError | NotFoundError> {
    const keyRecord = primaryKeyToRecord(this.primaryKey, pk);
    const key = serializePrimaryKey(this.primaryKey, keyRecord);
    if (!this.store.has(this.entityName, key)) {
      return err(this.notFound(keyRecord));
    }

    // The addressed primary key is authoritative: the updated record keeps the
    // key it was addressed by, regardless of any PK columns in the payload.
    const record: EntityRecord = { ...payload };
    for (const column of this.primaryKey) {
      record[column] = keyRecord[column];
    }

    const violations = this.validate(record, key);
    if (violations.length > 0) {
      return err(this.validationError(violations));
    }

    this.store.set(this.entityName, key, record);
    return ok(record);
  }

  /** Remove an existing record by primary key and confirm (Req 5.5, 5.7). */
  delete(pk: PrimaryKeyInput): Result<DeleteConfirmation, NotFoundError> {
    const keyRecord = primaryKeyToRecord(this.primaryKey, pk);
    const key = serializePrimaryKey(this.primaryKey, keyRecord);
    if (!this.store.has(this.entityName, key)) {
      return err(this.notFound(keyRecord));
    }
    this.store.delete(this.entityName, key);
    return ok({
      deleted: true,
      entityName: this.entityName,
      primaryKey: keyRecord,
    });
  }

  /**
   * Return a page of records ordered by primary key ascending (Req 5.8).
   * Defaults to page 1 with a size of 25. Rejects a requested size outside the
   * inclusive range [1, 100] with a validation error (Req 5.9).
   */
  list(request: PageRequest = {}): Result<Page, ValidationError> {
    const pageSize = request.size ?? DEFAULT_PAGE_SIZE;
    if (
      !Number.isInteger(pageSize) ||
      pageSize < MIN_PAGE_SIZE ||
      pageSize > MAX_PAGE_SIZE
    ) {
      return err(
        this.validationError([
          {
            attribute: '$pageSize',
            kind: 'RANGE',
            message: `Page size must be between ${MIN_PAGE_SIZE} and ${MAX_PAGE_SIZE} inclusive`,
          },
        ]),
      );
    }

    const page = request.page === undefined || request.page < 1 ? 1 : request.page;
    const all = this.store
      .entries(this.entityName)
      .map((e) => e.record)
      .sort((a, b) => comparePrimaryKey(this.primaryKey, a, b));

    const start = (page - 1) * pageSize;
    const records = all.slice(start, start + pageSize);
    return ok({ records, page, pageSize, total: all.length });
  }

  // -------------------------------------------------------------------------
  // Internal helpers
  // -------------------------------------------------------------------------

  /**
   * Auto-assign a UUID to a missing single-column UUID primary key (the
   * surrogate-key rule). Composite keys and non-UUID keys are never fabricated.
   */
  private assignSurrogateKey(record: EntityRecord): void {
    if (this.primaryKey.length !== 1) {
      return;
    }
    const column = this.primaryKey[0];
    if (!isEmptyValue(record[column])) {
      return;
    }
    const attribute = this.attributes.find((a) => a.name === column);
    if (attribute?.dataType === 'UUID') {
      record[column] = randomUUID();
    }
  }

  /**
   * Collect every constraint violation in `record`. `selfKey` is the serialized
   * key of the record being updated (excluded from uniqueness checks) or `null`
   * on create.
   */
  private validate(
    record: EntityRecord,
    selfKey: string | null,
  ): ConstraintViolation[] {
    const violations: ConstraintViolation[] = [];
    for (const attribute of this.attributes) {
      const value = record[attribute.name];
      for (const constraint of attribute.constraints) {
        this.checkConstraint(attribute, constraint, value, selfKey, violations);
      }
    }
    return violations;
  }

  /** Append a violation for a single constraint, if `value` violates it. */
  private checkConstraint(
    attribute: Attribute,
    constraint: AttributeConstraint,
    value: unknown,
    selfKey: string | null,
    violations: ConstraintViolation[],
  ): void {
    switch (constraint.kind) {
      case 'NOT_NULL': {
        if (isEmptyValue(value)) {
          violations.push({
            attribute: attribute.name,
            kind: 'NOT_NULL',
            message: `${attribute.name} is required and must not be empty`,
          });
        }
        return;
      }
      case 'UNIQUE': {
        // SQL semantics: NULL values are exempt from uniqueness (Req 2.1).
        if (isEmptyValue(value)) {
          return;
        }
        if (this.duplicateExists(attribute.name, value, selfKey)) {
          violations.push({
            attribute: attribute.name,
            kind: 'UNIQUE',
            message: `${attribute.name} must be unique; another ${this.entityName} record already holds this value`,
          });
        }
        return;
      }
      case 'FORMAT': {
        if (value === undefined || value === null) {
          return;
        }
        if (typeof value !== 'string' || !isValidEmail(value)) {
          violations.push({
            attribute: attribute.name,
            kind: 'FORMAT',
            message: `${attribute.name} must be a valid email address`,
          });
        }
        return;
      }
      case 'RANGE': {
        if (value === undefined || value === null) {
          return;
        }
        if (typeof value !== 'number' || Number.isNaN(value)) {
          violations.push({
            attribute: attribute.name,
            kind: 'RANGE',
            message: `${attribute.name} must be a number`,
          });
          return;
        }
        if (constraint.min !== undefined && value < constraint.min) {
          violations.push({
            attribute: attribute.name,
            kind: 'RANGE',
            message: `${attribute.name} must be >= ${constraint.min}`,
          });
        }
        if (constraint.max !== undefined && value > constraint.max) {
          violations.push({
            attribute: attribute.name,
            kind: 'RANGE',
            message: `${attribute.name} must be <= ${constraint.max}`,
          });
        }
        return;
      }
      case 'FOREIGN_KEY': {
        if (value === undefined || value === null) {
          return;
        }
        const exists = this.resolveForeignKey(
          constraint.references.entity,
          constraint.references.attribute,
          value,
        );
        // `undefined` => out of scope, skip (documented light FK scope).
        if (exists === false) {
          violations.push({
            attribute: attribute.name,
            kind: 'FOREIGN_KEY',
            message: `${attribute.name} references a ${constraint.references.entity} that does not exist`,
          });
        }
        return;
      }
      case 'PRIMARY_KEY':
        // Primary-key uniqueness is enforced in create() against the serialized
        // key; nothing to check per-attribute here.
        return;
      default:
        return;
    }
  }

  /** Whether another record (not `selfKey`) holds `value` for `attributeName`. */
  private duplicateExists(
    attributeName: string,
    value: unknown,
    selfKey: string | null,
  ): boolean {
    for (const { key, record } of this.store.entries(this.entityName)) {
      if (selfKey !== null && key === selfKey) {
        continue;
      }
      if (record[attributeName] === value) {
        return true;
      }
    }
    return false;
  }

  private validationError(violations: ConstraintViolation[]): ValidationError {
    return {
      kind: 'VALIDATION_ERROR',
      message: `${this.entityName} payload violated ${violations.length} constraint(s)`,
      violations,
    };
  }

  private notFound(keyRecord: EntityRecord): NotFoundError {
    return {
      kind: 'NOT_FOUND',
      message: `No ${this.entityName} record found for the given primary key`,
      entityName: this.entityName,
      primaryKey: pickPrimaryKey(this.primaryKey, keyRecord),
    };
  }
}

// ---------------------------------------------------------------------------
// EntityCrudSet — the full runtime for a model
// ---------------------------------------------------------------------------

/**
 * The complete CRUD runtime for a Data_Model: one {@link EntityCrud} per
 * entity, sharing a single {@link RecordStore}. Because every entity is
 * registered here, sibling entities can resolve each other's foreign-key
 * references for the light referential-existence check.
 */
export class EntityCrudSet {
  private readonly cruds = new Map<string, EntityCrud>();
  /** The shared store backing every entity's records. */
  readonly store: RecordStore;

  constructor(surface: ApiSurface, store: RecordStore) {
    this.store = store;

    // Primary-key columns by entity, used by the foreign-key resolver.
    const pkByEntity = new Map<string, string[]>();
    for (const descriptor of surface.entities) {
      pkByEntity.set(descriptor.entityName, descriptor.primaryKey);
    }

    const resolveForeignKey: ForeignKeyResolver = (entity, attribute, value) => {
      const pk = pkByEntity.get(entity);
      // Out of scope: unknown entity, or a composite / non-PK reference target.
      if (pk === undefined || pk.length !== 1 || pk[0] !== attribute) {
        return undefined;
      }
      const key = serializePrimaryKey(pk, { [attribute]: value });
      return this.store.has(entity, key);
    };

    for (const descriptor of surface.entities) {
      this.cruds.set(
        descriptor.entityName,
        new EntityCrud(descriptor, store, resolveForeignKey),
      );
    }
  }

  /** The CRUD operations for `entityName`, or undefined if not in the model. */
  get(entityName: string): EntityCrud | undefined {
    return this.cruds.get(entityName);
  }

  /** The names of every entity served by this runtime, in model order. */
  entityNames(): string[] {
    return [...this.cruds.keys()];
  }
}

/**
 * Build the CRUD runtime for a Data_Model. Generates the API surface from the
 * model and wires every entity to a shared store (an in-memory store is created
 * when none is supplied), enabling cross-entity foreign-key checks.
 */
export function buildCrudSet(
  model: DataModel,
  store: RecordStore = createInMemoryStore(),
): EntityCrudSet {
  return new EntityCrudSet(generateApiSurface(model), store);
}

/**
 * Build the CRUD runtime directly from a pre-generated {@link ApiSurface}, for
 * callers that already hold one. Uses an in-memory store when none is supplied.
 */
export function crudSetFromSurface(
  surface: ApiSurface,
  store: RecordStore = createInMemoryStore(),
): EntityCrudSet {
  return new EntityCrudSet(surface, store);
}
