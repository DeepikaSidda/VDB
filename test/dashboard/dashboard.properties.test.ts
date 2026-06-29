/**
 * Property-based tests for the Admin_Dashboard (tasks 10.3–10.4).
 *
 * Framework: vitest + fast-check (min 100 iterations per property, per the
 * design's Testing Strategy). Each property test is tagged exactly:
 *   `Feature: ai-database-architect, Property {n}: {property_text}`
 *
 * Components under test:
 * - src/dashboard/descriptor.ts `generateDescriptor` (Property 33, Req 7.1)
 * - src/dashboard/query.ts `searchRecords` / `filterRecords` (Property 34,
 *   Req 7.6, 7.7, 7.8)
 *
 * Strategy:
 * - Property 33 uses a DataModel arbitrary whose entities each have a UUID `id`
 *   primary key plus varied plain attributes, with model-unique entity names.
 *   The descriptor's entity-name set must equal the model's entity-name set.
 * - Property 34 uses a small dataset (<= 50 records) over a fixed set of known
 *   string/number fields, each record carrying a unique `id` for membership
 *   comparison. A random search term and a random eq/contains filter are
 *   generated, and the test computes the expected matching set independently
 *   from the implementation. Queries request a page size of 100 so a single
 *   page holds every match (total <= 50 <= 100), enabling exact membership
 *   comparison.
 */

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import type { Attribute, DataModel, DataType, Entity } from '../../src/model/types.js';
import { generateDescriptor } from '../../src/dashboard/descriptor.js';
import {
  searchRecords,
  filterRecords,
  type DashboardRecord,
  type Filter,
  type FilterOperator,
} from '../../src/dashboard/query.js';

const NUM_RUNS = 100;

// ---------------------------------------------------------------------------
// Property 33 — Dashboard lists exactly the model's entities (Req 7.1)
// ---------------------------------------------------------------------------

const SUPPORTED_DATA_TYPES: DataType[] = [
  'UUID',
  'TEXT',
  'VARCHAR',
  'INTEGER',
  'BIGINT',
  'NUMERIC',
  'BOOLEAN',
  'DATE',
  'TIMESTAMP',
  'JSON',
];

const dataTypeArb = fc.constantFrom(...SUPPORTED_DATA_TYPES);

/**
 * Build a Data_Model with `count` entities named E0..E{count-1} (unique within
 * the model), each with a UUID `id` primary key plus the given plain
 * attributes. Only entity names matter for Property 33, but realistic
 * attributes exercise the descriptor's per-attribute projection too.
 */
function buildModel(perEntityAttrTypes: DataType[][]): DataModel {
  const entities: Entity[] = perEntityAttrTypes.map((attrTypes, i) => {
    const attributes: Attribute[] = [
      { name: 'id', dataType: 'UUID', constraints: [{ kind: 'PRIMARY_KEY' }] },
    ];
    attrTypes.forEach((dt, j) => {
      attributes.push({ name: `a${i}_${j}`, dataType: dt, constraints: [] });
    });
    return {
      name: `E${i}`,
      attributes,
      primaryKey: ['id'],
      isJoinEntity: false,
    };
  });
  return { entities, relationships: [] };
}

const modelArb: fc.Arbitrary<DataModel> = fc
  .array(fc.array(dataTypeArb, { maxLength: 4 }), { minLength: 0, maxLength: 8 })
  .map((perEntityAttrTypes) => buildModel(perEntityAttrTypes));

describe('Admin_Dashboard property 33 (Req 7.1)', () => {
  it("Feature: ai-database-architect, Property 33: Dashboard lists exactly the model's entities", () => {
    fc.assert(
      fc.property(modelArb, (model) => {
        const descriptor = generateDescriptor(model);

        const descriptorNames = descriptor.entities.map((e) => e.entityName);
        const modelNames = model.entities.map((e) => e.name);

        // Exact set equality: same members, no extras, no missing. Sorting
        // makes the comparison order-independent.
        expect([...descriptorNames].sort()).toEqual([...modelNames].sort());

        // Every page size is bounded to <= 100 (Req 7.2 / 7.6).
        for (const view of descriptor.entities) {
          expect(view.pageSize).toBeLessThanOrEqual(100);
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 34 — Search and filter return exactly the matching records
//                (Req 7.6, 7.7, 7.8)
// ---------------------------------------------------------------------------

const SEARCHABLE_ATTRIBUTES = ['name', 'category'] as const;
const FILTERABLE_ATTRIBUTES = ['name', 'category', 'age', 'score'] as const;

const NAMES = ['Acme', 'Globex', 'Initech', 'Umbrella', 'Stark', 'Wayne'];
const CATEGORIES = ['alpha', 'beta', 'gamma', 'delta'];

type SampleRecord = DashboardRecord & {
  id: number;
  name: string;
  category: string;
  age: number;
  score: number;
};

const rawRecordArb = fc.record({
  name: fc.oneof(fc.constantFrom(...NAMES), fc.string({ maxLength: 6 })),
  category: fc.oneof(fc.constantFrom(...CATEGORIES), fc.string({ maxLength: 6 })),
  age: fc.integer({ min: 0, max: 120 }),
  score: fc.integer({ min: 0, max: 1000 }),
});

/** A dataset of <= 50 records, each given a unique `id` for membership tests. */
const datasetArb: fc.Arbitrary<SampleRecord[]> = fc
  .array(rawRecordArb, { maxLength: 50 })
  .map((raws) => raws.map((raw, id) => ({ id, ...raw })));

/** Search terms: empty/whitespace, fragments of known values, and noise. */
const searchTermArb = fc.oneof(
  fc.constant(''),
  fc.constant('   '),
  fc.constantFrom(...NAMES, ...CATEGORIES, 'ac', 'me', 'al', 'ta', 'x'),
  fc.string({ maxLength: 4 }),
);

const filterOperatorArb = fc.constantFrom<FilterOperator>('eq', 'contains');

/** Filter values biased toward existing values so matches actually occur. */
const filterValueArb = fc.oneof(
  fc.constantFrom(...NAMES, ...CATEGORIES),
  fc.integer({ min: 0, max: 1000 }),
  fc.string({ maxLength: 4 }),
);

const filterArb: fc.Arbitrary<Filter> = fc.record({
  attribute: fc.constantFrom(...FILTERABLE_ATTRIBUTES),
  operator: filterOperatorArb,
  value: filterValueArb,
});

// --- Independent reference implementations (computed in the test) -----------

function expectedSearchIds(
  records: SampleRecord[],
  term: string,
  searchable: readonly string[],
): number[] {
  const t = term.trim().toLowerCase();
  if (t === '') {
    return records.map((r) => r.id);
  }
  return records
    .filter((r) =>
      searchable.some((attr) => {
        const v = (r as DashboardRecord)[attr];
        if (v === null || v === undefined) return false;
        return String(v).toLowerCase().includes(t);
      }),
    )
    .map((r) => r.id);
}

function recordSatisfiesFilter(value: unknown, filter: Filter): boolean {
  switch (filter.operator) {
    case 'eq':
      return Object.is(value, filter.value);
    case 'contains': {
      if (filter.value === null || filter.value === undefined) return false;
      if (value === null || value === undefined) return false;
      return String(value)
        .toLowerCase()
        .includes(String(filter.value).toLowerCase());
    }
    default:
      // Property 34's generator only emits eq/contains.
      return false;
  }
}

function expectedFilterIds(records: SampleRecord[], filter: Filter): number[] {
  return records
    .filter((r) => recordSatisfiesFilter((r as DashboardRecord)[filter.attribute], filter))
    .map((r) => r.id);
}

function idsOf(records: readonly DashboardRecord[]): number[] {
  return records.map((r) => r.id as number);
}

function sortedNums(ns: number[]): number[] {
  return [...ns].sort((a, b) => a - b);
}

describe('Admin_Dashboard property 34 (Req 7.6, 7.7, 7.8)', () => {
  it('Feature: ai-database-architect, Property 34: Search and filter return exactly the matching records', () => {
    fc.assert(
      fc.property(datasetArb, searchTermArb, filterArb, (records, term, filter) => {
        // Request size 100 so a single page holds every match (total <= 50).
        const page = { size: 100 };

        // --- Search (Req 7.6, 7.8) ---
        const searchResult = searchRecords(records, term, SEARCHABLE_ATTRIBUTES, page);
        const expectedSearch = expectedSearchIds(records, term, SEARCHABLE_ATTRIBUTES);

        // Bounded to a page of at most 100 records.
        expect(searchResult.records.length).toBeLessThanOrEqual(100);
        // Total equals the expected matching count.
        expect(searchResult.total).toBe(expectedSearch.length);
        // Empty iff nothing matched.
        expect(searchResult.isEmpty).toBe(expectedSearch.length === 0);
        // Exact membership: every matching record and no other.
        expect(sortedNums(idsOf(searchResult.records))).toEqual(
          sortedNums(expectedSearch),
        );

        // --- Filter (Req 7.7, 7.8) ---
        const filterResult = filterRecords(records, [filter], page);
        const expectedFilter = expectedFilterIds(records, filter);

        expect(filterResult.records.length).toBeLessThanOrEqual(100);
        expect(filterResult.total).toBe(expectedFilter.length);
        expect(filterResult.isEmpty).toBe(expectedFilter.length === 0);
        expect(sortedNums(idsOf(filterResult.records))).toEqual(
          sortedNums(expectedFilter),
        );
      }),
      { numRuns: NUM_RUNS },
    );
  });
});
