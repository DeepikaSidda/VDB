/**
 * Import_Analyzer (Requirement 11) — STRETCH.
 *
 * Analyzes an existing external MySQL/PostgreSQL database and produces a
 * dialect-independent {@link DataModel} plus a set of improvement suggestions:
 *
 * - `importSchema(creds)` connects within 30s, introspects the source schema
 *   (tables/columns/types/PKs/FKs/indexes), and maps it into a Data_Model
 *   (Req 11.1). A source column whose type (or any element) cannot be mapped is
 *   recorded with a not-extracted indicator and extraction CONTINUES (Req 11.2).
 *   On a connect failure it distinguishes a connection timeout from an
 *   authentication failure (Req 11.5) and returns an error — because the result
 *   is a fresh value carried only on the success branch, any pre-existing
 *   Data_Model the caller holds is left unchanged.
 * - `suggest(model)` inspects a Data_Model and returns improvement suggestions
 *   covering missing primary keys, missing foreign keys, and normalization up
 *   to third normal form (Req 11.3); each suggestion identifies the affected
 *   element, the detected issue, and the proposed change.
 *
 * Like the {@link import('../provisioner/provisioner.js').Provisioner}, this
 * stays unit-testable without a live connection by depending only on the
 * injected {@link SourceDbDriver} port and an injectable {@link Clock} (see
 * ./sourceDriver.ts). Tests supply the {@link InMemorySource} fake; a real
 * driver-backed adapter (./pgSource.ts) is a documented placeholder.
 *
 * Note on the interface: the design sketches `importSchema` as synchronous, but
 * connecting to a live database is asynchronous, so — mirroring the Provisioner
 * — the method is `async` and returns a `Promise<Result<...>>`. The success
 * value is an {@link ImportResult} (the model plus the explicit `notExtracted`
 * list) rather than a bare `DataModel`, so the not-extracted indicators of
 * Req 11.2 are first-class; the affected attributes are also flagged
 * `needsReview` in the model itself.
 */

import type {
  Attribute,
  AttributeConstraint,
  DataModel,
  DataType,
  Entity,
  DbCredentials,
  Relationship,
} from '../model/types.js';
import { type Result, ok, err } from '../model/result.js';
import {
  type Clock,
  type SourceColumn,
  type SourceDbDriver,
  type SourceSchema,
  type SourceTable,
  CONNECT_TIMEOUT_MS,
  SourceAuthenticationError,
  SourceConnectionTimeoutError,
  systemClock,
} from './sourceDriver.js';

// ---------------------------------------------------------------------------
// Typed errors (Req 11.5)
// ---------------------------------------------------------------------------

/**
 * The error conditions an import can fail with, discriminated on `kind`.
 * Req 11.5 requires distinguishing a connection timeout from an authentication
 * failure; `EXTRACTION_FAILURE` covers an unexpected failure while reading the
 * schema after a successful connect.
 */
export type ImportError =
  | { kind: 'CONNECTION_TIMEOUT'; message: string }
  | { kind: 'AUTHENTICATION_FAILURE'; message: string }
  | { kind: 'EXTRACTION_FAILURE'; message: string };

// ---------------------------------------------------------------------------
// Not-extracted indicators (Req 11.2)
// ---------------------------------------------------------------------------

/**
 * A schema element that was encountered but could not be fully extracted into
 * the Data_Model (Req 11.2). Extraction records it and continues; the affected
 * attribute (when applicable) is also flagged `needsReview` in the model.
 */
export type NotExtractedElement = {
  /** What kind of element was not extracted. */
  element: 'COLUMN_TYPE';
  /** The source table the element belongs to. */
  table: string;
  /** The source column, when the element is column-scoped. */
  column: string;
  /** Human-readable reason, including the raw source value. */
  detail: string;
};

/**
 * The successful result of importing a schema: the reconstructed Data_Model
 * plus the explicit list of elements that were recorded but not extracted
 * (Req 11.2).
 */
export type ImportResult = {
  model: DataModel;
  notExtracted: NotExtractedElement[];
};

// ---------------------------------------------------------------------------
// Improvement suggestions (Req 11.3)
// ---------------------------------------------------------------------------

/** The category of an improvement suggestion. */
export type SuggestionKind =
  | 'MISSING_PRIMARY_KEY'
  | 'MISSING_FOREIGN_KEY'
  | 'NORMALIZATION';

/** A reference to the Data_Model element a suggestion concerns. */
export type ElementRef =
  | { kind: 'ENTITY'; entity: string }
  | { kind: 'ATTRIBUTE'; entity: string; attribute: string }
  | { kind: 'RELATIONSHIP'; source: string; target: string };

/**
 * A single improvement suggestion. Each identifies the affected schema element,
 * the detected issue, and the proposed change (Req 11.3). Suggestions are
 * advisory: the Schema_Generator only acts on the ones the user accepts
 * (Req 11.4, task 15.2 / the [MUST] pipeline).
 */
export type ImprovementSuggestion = {
  kind: SuggestionKind;
  element: ElementRef;
  /** The detected issue. */
  issue: string;
  /** The proposed change that would resolve the issue. */
  proposedChange: string;
};

// ---------------------------------------------------------------------------
// Source type -> Data_Model DataType mapping
// ---------------------------------------------------------------------------

/**
 * Mapping from a NORMALIZED source dialect type name to a Data_Model
 * {@link DataType}. Keyed on the lowercased type with any length/precision
 * `(...)` and integer modifiers (`unsigned`, `signed`, `zerofill`) stripped, so
 * `VARCHAR(255)`, `int unsigned`, and `NUMERIC(10,2)` all resolve. Covers the
 * common MySQL and PostgreSQL spellings; anything outside it is treated as an
 * unsupported type and recorded as not-extracted (Req 11.2).
 */
const SOURCE_TYPE_TO_DATA_TYPE: Record<string, DataType> = {
  // UUID
  uuid: 'UUID',
  // TEXT-ish
  text: 'TEXT',
  tinytext: 'TEXT',
  mediumtext: 'TEXT',
  longtext: 'TEXT',
  clob: 'TEXT',
  // VARCHAR / CHAR
  varchar: 'VARCHAR',
  'character varying': 'VARCHAR',
  char: 'VARCHAR',
  character: 'VARCHAR',
  nvarchar: 'VARCHAR',
  nchar: 'VARCHAR',
  // INTEGER
  int: 'INTEGER',
  integer: 'INTEGER',
  int4: 'INTEGER',
  smallint: 'INTEGER',
  int2: 'INTEGER',
  tinyint: 'INTEGER',
  mediumint: 'INTEGER',
  serial: 'INTEGER',
  serial4: 'INTEGER',
  // BIGINT
  bigint: 'BIGINT',
  int8: 'BIGINT',
  bigserial: 'BIGINT',
  serial8: 'BIGINT',
  // NUMERIC
  numeric: 'NUMERIC',
  decimal: 'NUMERIC',
  dec: 'NUMERIC',
  real: 'NUMERIC',
  float: 'NUMERIC',
  float4: 'NUMERIC',
  float8: 'NUMERIC',
  double: 'NUMERIC',
  'double precision': 'NUMERIC',
  money: 'NUMERIC',
  // BOOLEAN
  boolean: 'BOOLEAN',
  bool: 'BOOLEAN',
  bit: 'BOOLEAN',
  // DATE
  date: 'DATE',
  // TIMESTAMP
  timestamp: 'TIMESTAMP',
  timestamptz: 'TIMESTAMP',
  datetime: 'TIMESTAMP',
  'timestamp without time zone': 'TIMESTAMP',
  'timestamp with time zone': 'TIMESTAMP',
  // JSON
  json: 'JSON',
  jsonb: 'JSON',
};

/**
 * Normalize a raw source type string for lookup: lowercase, drop any
 * parenthesized length/precision, strip integer modifiers, and collapse
 * whitespace. e.g. `VARCHAR(255)` -> `varchar`, `INT UNSIGNED` -> `int`,
 * `timestamp without time zone` -> unchanged.
 */
function normalizeSourceType(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/\(.*\)/, '')
    .replace(/\b(unsigned|signed|zerofill)\b/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Map a raw source column type to a Data_Model {@link DataType}, or
 * `undefined` when it is unsupported (the Req 11.2 not-extracted condition).
 */
export function mapSourceType(rawType: string): DataType | undefined {
  return SOURCE_TYPE_TO_DATA_TYPE[normalizeSourceType(rawType)];
}

// ---------------------------------------------------------------------------
// Schema -> Data_Model extraction
// ---------------------------------------------------------------------------

/** Fallback Data_Model type assigned to a not-extracted (unsupported) column. */
const FALLBACK_DATA_TYPE: DataType = 'TEXT';

/** Build a single Data_Model attribute from a source column. */
function buildAttribute(
  table: SourceTable,
  column: SourceColumn,
  notExtracted: NotExtractedElement[],
): Attribute {
  const constraints: AttributeConstraint[] = [];

  const isPrimaryKey = table.primaryKey.includes(column.name);
  if (isPrimaryKey) {
    constraints.push({ kind: 'PRIMARY_KEY' });
  }
  if (!column.nullable) {
    constraints.push({ kind: 'NOT_NULL' });
  }
  if (column.unique) {
    constraints.push({ kind: 'UNIQUE' });
  }
  for (const fk of table.foreignKeys) {
    if (fk.column === column.name) {
      constraints.push({
        kind: 'FOREIGN_KEY',
        references: { entity: fk.referencesTable, attribute: fk.referencesColumn },
      });
    }
  }

  const mapped = mapSourceType(column.sourceType);
  if (mapped !== undefined) {
    return { name: column.name, dataType: mapped, constraints };
  }

  // Req 11.2 — unsupported type: record it as not-extracted, flag the
  // attribute for review, fall back to a safe type, and CONTINUE.
  notExtracted.push({
    element: 'COLUMN_TYPE',
    table: table.name,
    column: column.name,
    detail: `unsupported source type "${column.sourceType}" could not be mapped to a Data_Model type`,
  });
  return {
    name: column.name,
    dataType: FALLBACK_DATA_TYPE,
    constraints,
    needsReview: true,
  };
}

/**
 * Derive Data_Model relationships from a table's foreign keys. A foreign key on
 * `table` referencing another table is recorded as the dependent (FK-holding)
 * entity being the relationship source and the referenced entity the target,
 * with `ONE_TO_MANY` cardinality (the common "many rows reference one parent"
 * shape). This matches the Schema_Generator's convention (Req 2.5).
 */
function relationshipsOf(table: SourceTable): Relationship[] {
  return table.foreignKeys.map((fk) => ({
    source: table.name,
    target: fk.referencesTable,
    cardinality: 'ONE_TO_MANY' as const,
  }));
}

/**
 * Convert an introspected {@link SourceSchema} into a {@link DataModel},
 * collecting any not-extracted indicators (Req 11.1, 11.2).
 */
function schemaToDataModel(schema: SourceSchema): ImportResult {
  const notExtracted: NotExtractedElement[] = [];
  const entities: Entity[] = [];
  const relationships: Relationship[] = [];

  for (const table of schema.tables) {
    const attributes = table.columns.map((column) =>
      buildAttribute(table, column, notExtracted),
    );
    entities.push({
      name: table.name,
      attributes,
      primaryKey: [...table.primaryKey],
      isJoinEntity: false,
    });
    relationships.push(...relationshipsOf(table));
  }

  return { model: { entities, relationships }, notExtracted };
}

// ---------------------------------------------------------------------------
// The Import_Analyzer
// ---------------------------------------------------------------------------

/** The Import_Analyzer contract (Req 11). */
export interface ImportAnalyzer {
  importSchema(creds: DbCredentials): Promise<Result<ImportResult, ImportError>>;
  suggest(model: DataModel): ImprovementSuggestion[];
}

/**
 * Dependency-injected implementation of the {@link ImportAnalyzer}. Construct
 * it with a {@link SourceDbDriver} (in-memory fake in tests, real adapter in
 * production) and optionally a {@link Clock} for deterministic timeout logic.
 */
export class SourceImportAnalyzer implements ImportAnalyzer {
  private readonly driver: SourceDbDriver;
  private readonly clock: Clock;

  constructor(driver: SourceDbDriver, clock: Clock = systemClock) {
    this.driver = driver;
    this.clock = clock;
  }

  async importSchema(
    creds: DbCredentials,
  ): Promise<Result<ImportResult, ImportError>> {
    // --- Connect phase (Req 11.1, 11.5) -------------------------------------
    const connectStart = this.clock.now();
    let introspector;
    try {
      introspector = await this.driver.connect(creds, CONNECT_TIMEOUT_MS);
    } catch (error) {
      // Req 11.5 — distinguish the two connect failure modes. On error we
      // return without producing a model, so any existing model is unchanged.
      if (error instanceof SourceAuthenticationError) {
        return err({ kind: 'AUTHENTICATION_FAILURE', message: messageOf(error) });
      }
      if (error instanceof SourceConnectionTimeoutError) {
        return err({ kind: 'CONNECTION_TIMEOUT', message: messageOf(error) });
      }
      // An unclassified connect failure is treated as a connectivity timeout.
      return err({ kind: 'CONNECTION_TIMEOUT', message: messageOf(error) });
    }

    // Backstop deadline check: even if the driver returned, treat a connect
    // that took longer than the 30s window as a connection timeout (Req 11.5).
    if (this.clock.now() - connectStart > CONNECT_TIMEOUT_MS) {
      await safeClose(introspector);
      return err({
        kind: 'CONNECTION_TIMEOUT',
        message: `connection exceeded the ${CONNECT_TIMEOUT_MS}ms connect window`,
      });
    }

    // --- Extraction phase (Req 11.1, 11.2) ----------------------------------
    try {
      const schema = await introspector.introspect();
      await safeClose(introspector);
      return ok(schemaToDataModel(schema));
    } catch (error) {
      await safeClose(introspector);
      return err({ kind: 'EXTRACTION_FAILURE', message: messageOf(error) });
    }
  }

  suggest(model: DataModel): ImprovementSuggestion[] {
    return [
      ...missingPrimaryKeySuggestions(model),
      ...missingForeignKeySuggestions(model),
      ...normalizationSuggestions(model),
    ];
  }
}

// ---------------------------------------------------------------------------
// Suggestion heuristics (Req 11.3)
// ---------------------------------------------------------------------------

/**
 * Missing-PK: any entity with no primary key. Proposed change: add a surrogate
 * `id` primary key.
 */
function missingPrimaryKeySuggestions(
  model: DataModel,
): ImprovementSuggestion[] {
  const suggestions: ImprovementSuggestion[] = [];
  for (const entity of model.entities) {
    if (entity.primaryKey.length === 0) {
      suggestions.push({
        kind: 'MISSING_PRIMARY_KEY',
        element: { kind: 'ENTITY', entity: entity.name },
        issue: `Entity "${entity.name}" has no primary key.`,
        proposedChange: `Add a surrogate primary key "id" (UUID) to "${entity.name}".`,
      });
    }
  }
  return suggestions;
}

/**
 * Does a column name look like a foreign key by convention? Matches `x_id`,
 * `xId`, or a bare `<entity>_id`-style trailing-id name (but not a lone `id`,
 * which is normally the table's own surrogate key).
 */
function looksLikeForeignKey(columnName: string): boolean {
  if (/^id$/i.test(columnName)) {
    return false;
  }
  return /(_id|Id)$/.test(columnName);
}

/** Strip a trailing `_id` / `Id` to recover the referenced base name. */
function foreignKeyBaseName(columnName: string): string {
  return columnName.replace(/(_id|Id)$/, '');
}

/**
 * Missing-FK: a column that looks like a foreign key by naming
 * (e.g. `customer_id`) but carries no FOREIGN_KEY constraint. When an entity
 * whose name resembles the column's base name exists, it is named as the
 * likely target.
 */
function missingForeignKeySuggestions(
  model: DataModel,
): ImprovementSuggestion[] {
  const suggestions: ImprovementSuggestion[] = [];
  const entityNames = model.entities.map((e) => e.name);

  for (const entity of model.entities) {
    for (const attribute of entity.attributes) {
      const isFk = attribute.constraints.some((c) => c.kind === 'FOREIGN_KEY');
      if (isFk || !looksLikeForeignKey(attribute.name)) {
        continue;
      }
      const base = foreignKeyBaseName(attribute.name);
      const candidate = findCandidateEntity(base, entityNames);
      const target = candidate
        ? `entity "${candidate}"`
        : `the entity it identifies`;
      suggestions.push({
        kind: 'MISSING_FOREIGN_KEY',
        element: { kind: 'ATTRIBUTE', entity: entity.name, attribute: attribute.name },
        issue:
          `Column "${entity.name}.${attribute.name}" is named like a foreign ` +
          `key but has no foreign-key constraint.`,
        proposedChange:
          `Add a foreign-key constraint from "${entity.name}.${attribute.name}" ` +
          `to the primary key of ${target}.`,
      });
    }
  }
  return suggestions;
}

/**
 * Find an existing entity whose name resembles `base` (exact, or differing only
 * by a trailing plural `s`), case-insensitively.
 */
function findCandidateEntity(
  base: string,
  entityNames: string[],
): string | undefined {
  const b = base.toLowerCase();
  return entityNames.find((name) => {
    const n = name.toLowerCase();
    return n === b || n === `${b}s` || `${n}s` === b;
  });
}

/**
 * Normalization (up to 3NF) heuristics:
 *
 * - Repeating groups (1NF): two or more columns sharing a base name with a
 *   trailing number (e.g. `phone1`, `phone2` or `addr_1`, `addr_2`) indicate a
 *   repeating group that should be extracted into a related entity.
 * - Transitive dependency (3NF): a group of two or more columns sharing a
 *   `<prefix>_` and where a sibling `<prefix>_id` column (or an entity named
 *   like `<prefix>`) exists indicates the `<prefix>_*` attributes depend on the
 *   `<prefix>` key rather than the table's own key, and should move to a
 *   `<prefix>` entity.
 *
 * Heuristics are intentionally conservative and naming-based; they flag
 * candidates for the builder to accept or reject (Req 11.3 / 11.4).
 */
function normalizationSuggestions(
  model: DataModel,
): ImprovementSuggestion[] {
  const suggestions: ImprovementSuggestion[] = [];
  const entityNames = model.entities.map((e) => e.name);

  for (const entity of model.entities) {
    suggestions.push(...repeatingGroupSuggestions(entity));
    suggestions.push(...transitiveDependencySuggestions(entity, entityNames));
  }
  return suggestions;
}

/** Strip a trailing number (with an optional separating `_`) from a column name. */
function repeatingGroupBase(columnName: string): string | undefined {
  const match = /^(.*?)_?\d+$/.exec(columnName);
  if (!match) {
    return undefined;
  }
  const base = match[1];
  return base && base.length > 0 ? base : undefined;
}

/** Detect repeating-group columns (1NF violation) within one entity. */
function repeatingGroupSuggestions(entity: Entity): ImprovementSuggestion[] {
  const groups = new Map<string, string[]>();
  for (const attribute of entity.attributes) {
    const base = repeatingGroupBase(attribute.name);
    if (base === undefined) {
      continue;
    }
    const members = groups.get(base) ?? [];
    members.push(attribute.name);
    groups.set(base, members);
  }

  const suggestions: ImprovementSuggestion[] = [];
  for (const [base, members] of groups) {
    if (members.length >= 2) {
      suggestions.push({
        kind: 'NORMALIZATION',
        element: { kind: 'ENTITY', entity: entity.name },
        issue:
          `Entity "${entity.name}" has a repeating group of columns ` +
          `(${members.join(', ')}), which violates first normal form.`,
        proposedChange:
          `Extract the repeating "${base}" values into a separate "${base}" ` +
          `entity related one-to-many to "${entity.name}".`,
      });
    }
  }
  return suggestions;
}

/** Detect transitively-dependent column groups (3NF violation) within one entity. */
function transitiveDependencySuggestions(
  entity: Entity,
  entityNames: string[],
): ImprovementSuggestion[] {
  const pk = new Set(entity.primaryKey);
  // Group non-PK columns by their `<prefix>_` token.
  const groups = new Map<string, string[]>();
  for (const attribute of entity.attributes) {
    if (pk.has(attribute.name)) {
      continue;
    }
    const underscore = attribute.name.indexOf('_');
    if (underscore <= 0) {
      continue;
    }
    const prefix = attribute.name.slice(0, underscore);
    const members = groups.get(prefix) ?? [];
    members.push(attribute.name);
    groups.set(prefix, members);
  }

  const suggestions: ImprovementSuggestion[] = [];
  for (const [prefix, members] of groups) {
    const hasIdColumn = members.some((m) => /(_id)$/i.test(m));
    const hasNonIdColumn = members.some((m) => !/(_id)$/i.test(m));
    const matchesEntity = findCandidateEntity(prefix, entityNames) !== undefined;
    // Require at least one descriptive (non-id) column plus evidence the prefix
    // names a real concept (a sibling `<prefix>_id` or an entity named for it),
    // and at least two columns in the group, to avoid flagging incidental names.
    if (members.length >= 2 && hasNonIdColumn && (hasIdColumn || matchesEntity)) {
      suggestions.push({
        kind: 'NORMALIZATION',
        element: { kind: 'ENTITY', entity: entity.name },
        issue:
          `Columns (${members.join(', ')}) in "${entity.name}" appear to ` +
          `depend on "${prefix}" rather than the entity's primary key, which ` +
          `violates third normal form.`,
        proposedChange:
          `Move the "${prefix}_*" attributes into a separate "${prefix}" ` +
          `entity and reference it from "${entity.name}" by foreign key.`,
      });
    }
  }
  return suggestions;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function safeClose(introspector: {
  close(): Promise<void>;
}): Promise<void> {
  try {
    await introspector.close();
  } catch {
    // Best-effort cleanup.
  }
}
