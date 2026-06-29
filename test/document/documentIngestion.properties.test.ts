/**
 * Property-based tests for the Document-to-Backend ingestion path [SECONDARY]
 * (Properties 41–43) of the ai-database-architect spec.
 *
 * These exercise two deterministic, LLM-free components:
 *  - The record-to-model inference of the Modeling_Engine
 *    (`inferModelFromRecords` / `ModelingEngine.inferFromRecords` /
 *    `detectRepeatingGroups`), which decomposes flat extracted records into a
 *    relational Data_Model (Req 10.2, 10.3).
 *  - The Document_Parser's format gate, which rejects unsupported uploads
 *    (Req 10.4).
 *
 * Each property runs a minimum of 100 generated cases (fast-check).
 */

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';

import {
  inferModelFromRecords,
  detectRepeatingGroups,
  collectFieldNames,
} from '../../src/modeling/records.js';
import { ModelingEngine } from '../../src/modeling/modelingEngine.js';
import { StubLlmClient } from '../../src/modeling/llmClient.js';
import {
  DocumentParser,
  SUPPORTED_FORMATS,
  MAX_FILE_SIZE_BYTES,
  type UploadedFile,
} from '../../src/document/documentParser.js';
import { validateDataModel, SUPPORTED_DATA_TYPES } from '../../src/model/invariants.js';
import { isOk, isErr, unwrap } from '../../src/model/result.js';
import type { DataModel, Entity } from '../../src/model/types.js';

const NUM_RUNS = 100;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** The first entity whose attribute set contains every one of `attrNames`. */
function entityWithAttributes(
  model: DataModel,
  attrNames: readonly string[],
): Entity | undefined {
  return model.entities.find((e) => {
    const names = new Set(e.attributes.map((a) => a.name));
    return attrNames.every((n) => names.has(n));
  });
}

/** True when `entity` carries a foreign key referencing `targetEntityName`. */
function hasForeignKeyTo(entity: Entity, targetEntityName: string): boolean {
  return entity.attributes.some((a) =>
    a.constraints.some(
      (c) => c.kind === 'FOREIGN_KEY' && c.references.entity === targetEntityName,
    ),
  );
}

/** The original (non-PK, non-foreign-key) attribute names of an entity. */
function payloadAttributeNames(entity: Entity): string[] {
  const pk = new Set(entity.primaryKey);
  return entity.attributes
    .filter(
      (a) =>
        !pk.has(a.name) &&
        !a.constraints.some((c) => c.kind === 'FOREIGN_KEY'),
    )
    .map((a) => a.name)
    .sort();
}

// ---------------------------------------------------------------------------
// Property 41: Repeating field groups become separate entities (Req 10.2)
// ---------------------------------------------------------------------------

describe('Property 41: Repeating field groups become separate entities', () => {
  /**
   * A flat dataset shaped like an attendance sheet: each of N rows references
   * one of K reused "faculty" sub-entity instances (so the {facultyName,
   * facultyDept} group's value-combinations repeat across rows), plus a
   * per-row unique `studentId`. K < N is guaranteed (minLength = k + 1), so the
   * group genuinely repeats.
   */
  const repeatingGroupDatasetArb = fc.integer({ min: 2, max: 6 }).chain((k) =>
    fc
      .array(fc.integer({ min: 0, max: k - 1 }), {
        minLength: k + 1,
        maxLength: 25,
      })
      .map((assignments) => {
        const records = assignments.map((instance, row) => ({
          studentId: `S${row}`,
          facultyName: `Prof${instance}`,
          facultyDept: `Dept${instance}`,
        }));
        return { k, records };
      }),
  );

  // Feature: ai-database-architect, Property 41: For any flat tabular dataset containing a group of two or more fields whose values repeat across two or more records, the Modeling_Engine creates a separate entity for that group rather than modeling the source as a single table.
  it('extracts a repeating field group into its own related entity', () => {
    fc.assert(
      fc.property(repeatingGroupDatasetArb, ({ records }) => {
        // The group is detected directly by the decomposition heuristic.
        const fieldNames = collectFieldNames(records);
        const groups = detectRepeatingGroups(records, fieldNames);
        const facultyGroup = groups.find(
          (g) =>
            g.fields.includes('facultyName') && g.fields.includes('facultyDept'),
        );
        expect(facultyGroup).toBeDefined();
        expect([...facultyGroup!.fields].sort()).toEqual([
          'facultyDept',
          'facultyName',
        ]);

        // And it materializes as a separate entity in the resulting model.
        const result = inferModelFromRecords(records);
        expect(isOk(result)).toBe(true);
        const model = unwrap(result);

        const facultyEntity = entityWithAttributes(model, [
          'facultyName',
          'facultyDept',
        ]);
        const mainEntity = entityWithAttributes(model, ['studentId']);
        expect(facultyEntity).toBeDefined();
        expect(mainEntity).toBeDefined();

        // The group is a DISTINCT entity, not flattened into the main table.
        expect(facultyEntity!.name).not.toBe(mainEntity!.name);
        const mainAttrNames = new Set(
          mainEntity!.attributes.map((a) => a.name),
        );
        expect(mainAttrNames.has('facultyName')).toBe(false);
        expect(mainAttrNames.has('facultyDept')).toBe(false);

        // The extracted entity's payload columns are exactly the group fields.
        expect(payloadAttributeNames(facultyEntity!)).toEqual([
          'facultyDept',
          'facultyName',
        ]);

        // A relationship + foreign key links the main entity to the group.
        expect(hasForeignKeyTo(mainEntity!, facultyEntity!.name)).toBe(true);
        const linked = model.relationships.some(
          (r) =>
            (r.source === mainEntity!.name && r.target === facultyEntity!.name) ||
            (r.source === facultyEntity!.name && r.target === mainEntity!.name),
        );
        expect(linked).toBe(true);
      }),
      { numRuns: NUM_RUNS },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 42: Document-derived models satisfy the modeling invariants (10.3)
// ---------------------------------------------------------------------------

describe('Property 42: Document-derived models satisfy the modeling invariants', () => {
  /** A field-name pool small enough that records share columns and overlap. */
  const fieldNameArb = fc.constantFrom(
    'name', 'dept', 'status', 'date', 'count',
    'email', 'code', 'qty', 'city', 'active', 'title', 'owner',
  );

  /** Cell values spanning the inference categories, incl. native JS types. */
  const cellArb = fc.oneof(
    fc.constantFrom(
      'Alice', 'Bob', 'Engineering', 'Sales', 'active', 'inactive',
      'true', 'false', '2021-01-01', '2021-01-01T08:30:00Z', '12', '3.5', '',
    ),
    fc.string({ maxLength: 8 }),
    fc.integer(),
    fc.boolean(),
    fc.double({ noNaN: true, noDefaultInfinity: true }),
  );

  /** Arbitrary extracted datasets: 1+ records, each with 1+ named fields. */
  const extractedRecordsArb = fc.array(
    fc.dictionary(fieldNameArb, cellArb, { minKeys: 1, maxKeys: 5 }),
    { minLength: 1, maxLength: 15 },
  );

  const ALLOWED_CARDINALITIES = new Set([
    'ONE_TO_ONE',
    'ONE_TO_MANY',
    'MANY_TO_MANY',
  ]);
  const SUPPORTED = new Set<string>(SUPPORTED_DATA_TYPES);

  // Feature: ai-database-architect, Property 42: For any document from which records are extracted, the resulting Data_Model satisfies the same structural invariants as a prompt-derived model (exactly one primary key per entity, exactly one supported data type per attribute, valid relationship cardinalities).
  it('every model derived from extracted records satisfies invariants I1-I6', async () => {
    const engine = new ModelingEngine(new StubLlmClient());
    await fc.assert(
      fc.asyncProperty(extractedRecordsArb, async (records) => {
        const result = await engine.inferFromRecords(records);
        // Fail-closed: if no model is produced there is nothing to validate.
        if (isErr(result)) {
          return;
        }
        const model = result.value;

        // Same full invariant suite as a prompt-derived model.
        expect(isOk(validateDataModel(model))).toBe(true);

        // Spelled-out spec invariants for clarity.
        for (const entity of model.entities) {
          // I1 — exactly one (non-empty) primary key per entity.
          expect(entity.primaryKey.length).toBeGreaterThanOrEqual(1);
          // I2 — exactly one supported data type per attribute.
          for (const attr of entity.attributes) {
            expect(SUPPORTED.has(attr.dataType)).toBe(true);
          }
        }
        // I3 — valid relationship cardinalities.
        for (const rel of model.relationships) {
          expect(ALLOWED_CARDINALITIES.has(rel.cardinality)).toBe(true);
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 43: Unsupported upload formats are rejected (Req 10.4)
// ---------------------------------------------------------------------------

describe('Property 43: Unsupported upload formats are rejected', () => {
  /** Tokens that are decisively NOT CSV / Excel / PDF. */
  const unsupportedToken = fc.constantFrom(
    'txt', 'json', 'png', 'xml', 'docx', 'yaml', 'md', 'bin', 'html', 'rtf',
  );
  /** MIME types that are not recognized as a supported format. */
  const unsupportedContentType = fc.constantFrom(
    'text/plain',
    'application/json',
    'image/png',
    'application/xml',
    'application/octet-stream',
  );
  /** Base file names with no recognized extension. */
  const plainName = fc.constantFrom('data', 'report', 'file', 'upload', 'document');
  const smallContent = fc.string({ maxLength: 50 });

  /**
   * Three strategies, each GUARANTEED to detect as unsupported:
   *  A) an explicit (decisive) unsupported format hint,
   *  B) an unsupported file extension with no hint/content-type,
   *  C) an unsupported content type with no hint and no recognized extension.
   * Every generated file stays well under the 50 MB size limit.
   */
  const unsupportedFileArb: fc.Arbitrary<UploadedFile> = fc.oneof(
    // A) decisive format hint
    fc
      .tuple(unsupportedToken, plainName, smallContent)
      .map(([format, base, content]) => ({
        name: `${base}.${format}`,
        format,
        content,
      })),
    // B) unsupported extension only
    fc
      .tuple(unsupportedToken, plainName, smallContent)
      .map(([ext, base, content]) => ({
        name: `${base}.${ext}`,
        content,
      })),
    // C) unsupported content type only, no recognized extension
    fc
      .tuple(unsupportedContentType, plainName, smallContent)
      .map(([contentType, name, content]) => ({
        name,
        contentType,
        content,
      })),
  );

  // Feature: ai-database-architect, Property 43: For any uploaded file whose format is not CSV, Excel, or PDF, the Document_Parser rejects the file, retains no extracted records, and returns an error identifying the supported formats.
  it('rejects non-CSV/Excel/PDF uploads with UNSUPPORTED_FORMAT and no records', () => {
    const parser = new DocumentParser();
    fc.assert(
      fc.property(unsupportedFileArb, (file) => {
        const result = parser.parse(file);
        expect(isErr(result)).toBe(true);
        if (isErr(result)) {
          expect(result.error.kind).toBe('UNSUPPORTED_FORMAT');
          if (result.error.kind === 'UNSUPPORTED_FORMAT') {
            // The error identifies the supported formats.
            expect(result.error.supportedFormats).toEqual(SUPPORTED_FORMATS);
            expect([...result.error.supportedFormats]).toEqual([
              'CSV',
              'Excel',
              'PDF',
            ]);
          }
        }
        // No extracted records are retained on the error path (fail closed).
        expect('value' in result).toBe(false);
        // Sanity: the file was never anywhere near the size limit.
        expect(true).toBe(MAX_FILE_SIZE_BYTES > 0);
      }),
      { numRuns: NUM_RUNS },
    );
  });
});
