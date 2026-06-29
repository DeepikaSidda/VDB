/**
 * Property-based tests for the generated CRUD runtime (tasks 7.3–7.9).
 *
 * Framework: vitest + fast-check (min 100 iterations per property, per the
 * design's Testing Strategy). Each property test is tagged exactly:
 *   `Feature: ai-database-architect, Property {n}: {property_text}`
 *
 * Components under test:
 *  - src/api/apiGenerator.ts  `generate`        (the API surface)
 *  - src/api/crudRuntime.ts   `buildCrudSet` / `EntityCrud` (the runtime)
 *  - src/dashboard/descriptor.ts `generateDescriptor` (Property 26 page size)
 *
 * Strategy: a smart `modelArb` produces Data_Models whose every entity has a
 * single-column UUID `id` primary key (auto-assigned by the runtime on create)
 * plus a varied set of attributes drawn from five flavors — plain text,
 * NOT_NULL text, UNIQUE text, FORMAT/EMAIL, and RANGE{min:0} integer. From an
 * entity blueprint we derive both constraint-satisfying payloads (used for the
 * positive round-trip / pagination properties) and constraint-violating
 * payloads (used for Property 23). A fresh `createInMemoryStore()` backs every
 * generated case so runs never bleed into each other.
 */

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import type {
  Attribute,
  AttributeConstraint,
  DataModel,
  Entity,
} from '../../src/model/types.js';
import { isOk, isErr } from '../../src/model/result.js';
import { generate as generateApiSurface } from '../../src/api/apiGenerator.js';
import {
  buildCrudSet,
  createInMemoryStore,
  DEFAULT_PAGE_SIZE,
  MIN_PAGE_SIZE,
  MAX_PAGE_SIZE,
  type EntityRecord,
} from '../../src/api/crudRuntime.js';
import { generateDescriptor } from '../../src/dashboard/descriptor.js';

// ---------------------------------------------------------------------------
// Shared configuration
// ---------------------------------------------------------------------------

const NUM_RUNS = 100;

const CRUD_OPERATIONS = ['CREATE', 'READ', 'UPDATE', 'DELETE', 'LIST'] as const;

/** Attribute flavors the model arbitrary can emit for an entity. */
type Flavor = 'plainText' | 'notNullText' | 'uniqueText' | 'email' | 'rangeInt';

const ALL_FLAVORS: Flavor[] = [
  'plainText',
  'notNullText',
  'uniqueText',
  'email',
  'rangeInt',
];

/** Flavors that carry a constraint a single payload can violate on its own. */
const VIOLATABLE_FLAVORS: Flavor[] = [
  'notNullText',
  'uniqueText',
  'email',
  'rangeInt',
];

/** A generated attribute together with its flavor (drives value generation). */
type AttrBP = { name: string; flavor: Flavor; attribute: Attribute };

/** A generated entity blueprint: its model `Entity` plus per-attribute flavors. */
type EntityBP = {
  name: string;
  attrs: AttrBP[];
  entity: Entity;
};

// ---------------------------------------------------------------------------
// Attribute construction
// ---------------------------------------------------------------------------

function attributeForFlavor(name: string, flavor: Flavor): Attribute {
  switch (flavor) {
    case 'plainText':
      return { name, dataType: 'TEXT', constraints: [] };
    case 'notNullText':
      return { name, dataType: 'TEXT', constraints: [{ kind: 'NOT_NULL' }] };
    case 'uniqueText':
      return { name, dataType: 'TEXT', constraints: [{ kind: 'UNIQUE' }] };
    case 'email':
      return {
        name,
        dataType: 'VARCHAR',
        constraints: [{ kind: 'FORMAT', format: 'EMAIL' }],
      };
    case 'rangeInt':
      return {
        name,
        dataType: 'INTEGER',
        constraints: [{ kind: 'RANGE', min: 0 }],
      };
  }
}

/** The constraint kind whose violation a flavor's bad value triggers. */
function constraintKindOf(flavor: Flavor): AttributeConstraint['kind'] {
  switch (flavor) {
    case 'notNullText':
      return 'NOT_NULL';
    case 'uniqueText':
      return 'UNIQUE';
    case 'email':
      return 'FORMAT';
    case 'rangeInt':
      return 'RANGE';
    default:
      return 'NOT_NULL';
  }
}

// ---------------------------------------------------------------------------
// Value arbitraries
// ---------------------------------------------------------------------------

const alphaArb = fc.constantFrom(
  'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'x', 'y', 'z',
  '0', '1', '2', '3', '4', '5',
);

const segmentArb = fc
  .array(alphaArb, { minLength: 1, maxLength: 6 })
  .map((chars) => chars.join(''));

/** Well-formed emails: non-empty local, single `@`, domain containing a `.`. */
const validEmailArb = fc
  .tuple(segmentArb, segmentArb, fc.constantFrom('com', 'org', 'net', 'io'))
  .map(([local, domain, tld]) => `${local}@${domain}.${tld}`);

function validValueArbForFlavor(flavor: Flavor): fc.Arbitrary<unknown> {
  switch (flavor) {
    case 'plainText':
      return fc.string({ maxLength: 12 });
    case 'notNullText':
    case 'uniqueText':
      // Non-empty so NOT_NULL is satisfied; UNIQUE is trivially satisfied for a
      // single record in a fresh store.
      return fc.string({ minLength: 1, maxLength: 12 });
    case 'email':
      return validEmailArb;
    case 'rangeInt':
      return fc.integer({ min: 0, max: 1_000_000 });
  }
}

/** A value that violates the flavor's own constraint (for single-payload tests). */
function violatingValueArbForFlavor(flavor: Flavor): fc.Arbitrary<unknown> {
  switch (flavor) {
    case 'notNullText':
      // Empty string is treated as null/absent by NOT_NULL (Req 2.2 wording).
      return fc.constant('');
    case 'email':
      // Strip every "@" so it can never be a well-formed address.
      return fc.string({ maxLength: 12 }).map((s) => s.replace(/@/g, 'X'));
    case 'rangeInt':
      return fc.integer({ min: -1_000_000, max: -1 });
    default:
      // uniqueText is handled via a seeded duplicate, not a standalone value.
      return fc.constant('');
  }
}

// ---------------------------------------------------------------------------
// Entity / model arbitraries
// ---------------------------------------------------------------------------

function makeEntityBP(name: string, flavors: Flavor[]): EntityBP {
  const attrs: AttrBP[] = flavors.map((flavor, j) => {
    const an = `a${j}`;
    return { name: an, flavor, attribute: attributeForFlavor(an, flavor) };
  });
  const entity: Entity = {
    name,
    attributes: [
      { name: 'id', dataType: 'UUID', constraints: [] },
      ...attrs.map((a) => a.attribute),
    ],
    primaryKey: ['id'],
    isJoinEntity: false,
  };
  return { name, attrs, entity };
}

const flavorArb = fc.constantFrom(...ALL_FLAVORS);

/** An entity blueprint with 0..4 varied attributes plus its UUID `id` PK. */
function entityBPArb(index: number): fc.Arbitrary<EntityBP> {
  return fc
    .array(flavorArb, { maxLength: 4 })
    .map((flavors) => makeEntityBP(`E${index}`, flavors));
}

/** An entity blueprint guaranteed to carry at least one violatable attribute. */
function violatableEntityBPArb(index: number): fc.Arbitrary<EntityBP> {
  return fc
    .tuple(fc.constantFrom(...VIOLATABLE_FLAVORS), fc.array(flavorArb, { maxLength: 3 }))
    .map(([guaranteed, rest]) => makeEntityBP(`E${index}`, [guaranteed, ...rest]));
}

/** A multi-entity model (1..5 entities), each with a UUID id PK, no FKs. */
const modelArb: fc.Arbitrary<{ model: DataModel; entityBPs: EntityBP[] }> = fc
  .integer({ min: 1, max: 5 })
  .chain((count) =>
    fc
      .tuple(...Array.from({ length: count }, (_, i) => entityBPArb(i)))
      .map((bps) => {
        const entityBPs = bps as EntityBP[];
        return {
          model: {
            entities: entityBPs.map((b) => b.entity),
            relationships: [],
          },
          entityBPs,
        };
      }),
  );

/** A single-entity model wrapper. */
function singleEntityModel(bp: EntityBP): DataModel {
  return { entities: [bp.entity], relationships: [] };
}

/** Build a constraint-satisfying payload (excludes `id`, left to auto-assign). */
function validPayloadArb(bp: EntityBP): fc.Arbitrary<EntityRecord> {
  if (bp.attrs.length === 0) {
    return fc.constant<EntityRecord>({});
  }
  const arbs = bp.attrs.map((a) => validValueArbForFlavor(a.flavor));
  return fc.tuple(...arbs).map((values) => {
    const record: EntityRecord = {};
    bp.attrs.forEach((a, i) => {
      record[a.name] = values[i];
    });
    return record;
  });
}

/** Ascending comparison matching the runtime's primary-key string ordering. */
function byUuidAscending(a: EntityRecord, b: EntityRecord): number {
  const as = String(a.id);
  const bs = String(b.id);
  return as < bs ? -1 : as > bs ? 1 : 0;
}

// ---------------------------------------------------------------------------
// Property 20 — CRUD surface is complete for every entity
// ---------------------------------------------------------------------------

describe('CRUD runtime property 20 (Req 5.1)', () => {
  it('Feature: ai-database-architect, Property 20: CRUD surface is complete for every entity', () => {
    fc.assert(
      fc.property(modelArb, ({ model }) => {
        const surface = generateApiSurface(model);
        const crudSet = buildCrudSet(model);

        for (const entity of model.entities) {
          // The generated API surface exposes all five operations.
          const descriptor = surface.entities.find(
            (d) => d.entityName === entity.name,
          );
          expect(descriptor).toBeDefined();
          const operations = new Set(
            descriptor!.endpoints.map((ep) => ep.operation),
          );
          for (const op of CRUD_OPERATIONS) {
            expect(operations.has(op)).toBe(true);
          }

          // The runtime exposes a callable handler for each operation.
          const crud = crudSet.get(entity.name);
          expect(crud).toBeDefined();
          expect(typeof crud!.create).toBe('function');
          expect(typeof crud!.read).toBe('function');
          expect(typeof crud!.update).toBe('function');
          expect(typeof crud!.delete).toBe('function');
          expect(typeof crud!.list).toBe('function');
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 21 — Create/read/update round-trip preserves records
// ---------------------------------------------------------------------------

describe('CRUD runtime property 21 (Req 5.2, 5.3, 5.4)', () => {
  it('Feature: ai-database-architect, Property 21: Create/read/update round-trip preserves records', () => {
    fc.assert(
      fc.property(
        entityBPArb(0).chain((bp) =>
          fc
            .tuple(validPayloadArb(bp), validPayloadArb(bp))
            .map(([createPayload, updatePayload]) => ({
              bp,
              createPayload,
              updatePayload,
            })),
        ),
        ({ bp, createPayload, updatePayload }) => {
          const crud = buildCrudSet(singleEntityModel(bp), createInMemoryStore()).get(
            bp.name,
          )!;

          // create returns the record with an assigned primary key (Req 5.2).
          const created = crud.create(createPayload);
          expect(isOk(created)).toBe(true);
          if (!isOk(created)) return;
          const pk = created.value.id;
          expect(typeof pk).toBe('string');
          expect(pk).not.toBe('');

          // read by PK returns an equal record (Req 5.3).
          const read = crud.read(pk as string);
          expect(isOk(read)).toBe(true);
          if (!isOk(read)) return;
          expect(read.value).toEqual(created.value);

          // update then read returns the updated record (Req 5.4); PK preserved.
          const updated = crud.update(pk as string, updatePayload);
          expect(isOk(updated)).toBe(true);
          if (!isOk(updated)) return;
          expect(updated.value.id).toBe(pk);

          const readAfter = crud.read(pk as string);
          expect(isOk(readAfter)).toBe(true);
          if (!isOk(readAfter)) return;
          expect(readAfter.value).toEqual(updated.value);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 22 — Delete removes the record
// ---------------------------------------------------------------------------

describe('CRUD runtime property 22 (Req 5.5)', () => {
  it('Feature: ai-database-architect, Property 22: Delete removes the record', () => {
    fc.assert(
      fc.property(
        entityBPArb(0).chain((bp) =>
          validPayloadArb(bp).map((payload) => ({ bp, payload })),
        ),
        ({ bp, payload }) => {
          const crud = buildCrudSet(singleEntityModel(bp), createInMemoryStore()).get(
            bp.name,
          )!;

          const created = crud.create(payload);
          expect(isOk(created)).toBe(true);
          if (!isOk(created)) return;
          const pk = created.value.id as string;

          // delete returns a deletion confirmation (Req 5.5).
          const deleted = crud.delete(pk);
          expect(isOk(deleted)).toBe(true);
          if (!isOk(deleted)) return;
          expect(deleted.value.deleted).toBe(true);

          // a subsequent read returns a not-found error.
          const read = crud.read(pk);
          expect(isErr(read)).toBe(true);
          if (isErr(read)) {
            expect(read.error.kind).toBe('NOT_FOUND');
          }
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 23 — Constraint-violating payloads are rejected without persistence
// ---------------------------------------------------------------------------

type ViolationScenario =
  | {
      mode: 'single';
      bp: EntityBP;
      target: string;
      kind: AttributeConstraint['kind'];
      payload: EntityRecord;
    }
  | {
      mode: 'unique';
      bp: EntityBP;
      target: string;
      kind: AttributeConstraint['kind'];
      seedPayload: EntityRecord;
      secondPayload: EntityRecord;
    };

const violationScenarioArb: fc.Arbitrary<ViolationScenario> = violatableEntityBPArb(
  0,
).chain((bp) => {
  const violatable = bp.attrs.filter((a) => a.flavor !== 'plainText');
  return fc.constantFrom(...violatable).chain((target) => {
    const kind = constraintKindOf(target.flavor);
    if (target.flavor === 'uniqueText') {
      return fc
        .tuple(validPayloadArb(bp), validPayloadArb(bp))
        .map(([seedPayload, second]): ViolationScenario => ({
          mode: 'unique',
          bp,
          target: target.name,
          kind,
          seedPayload,
          // Duplicate the seed's unique value to force a UNIQUE violation.
          secondPayload: { ...second, [target.name]: seedPayload[target.name] },
        }));
    }
    return fc
      .tuple(validPayloadArb(bp), violatingValueArbForFlavor(target.flavor))
      .map(([base, bad]): ViolationScenario => ({
        mode: 'single',
        bp,
        target: target.name,
        kind,
        payload: { ...base, [target.name]: bad },
      }));
  });
});

describe('CRUD runtime property 23 (Req 5.6)', () => {
  it('Feature: ai-database-architect, Property 23: Constraint-violating payloads are rejected without persistence', () => {
    fc.assert(
      fc.property(violationScenarioArb, (scenario) => {
        const crud = buildCrudSet(
          singleEntityModel(scenario.bp),
          createInMemoryStore(),
        ).get(scenario.bp.name)!;

        if (scenario.mode === 'single') {
          const result = crud.create(scenario.payload);
          expect(isErr(result)).toBe(true);
          if (isErr(result)) {
            expect(result.error.kind).toBe('VALIDATION_ERROR');
            if (result.error.kind === 'VALIDATION_ERROR') {
              // The violation for the targeted attribute/constraint is reported.
              expect(
                result.error.violations.some(
                  (v) => v.attribute === scenario.target && v.kind === scenario.kind,
                ),
              ).toBe(true);
            }
          }
          // Nothing persisted.
          const list = crud.list();
          expect(isOk(list)).toBe(true);
          if (isOk(list)) {
            expect(list.value.total).toBe(0);
          }
          return;
        }

        // unique mode: seed a valid record, then attempt a duplicate.
        const seed = crud.create(scenario.seedPayload);
        expect(isOk(seed)).toBe(true);
        if (!isOk(seed)) return;

        const dup = crud.create(scenario.secondPayload);
        expect(isErr(dup)).toBe(true);
        if (isErr(dup)) {
          expect(dup.error.kind).toBe('VALIDATION_ERROR');
          if (dup.error.kind === 'VALIDATION_ERROR') {
            expect(
              dup.error.violations.some(
                (v) => v.attribute === scenario.target && v.kind === 'UNIQUE',
              ),
            ).toBe(true);
          }
        }
        // Only the seed remains persisted.
        const list = crud.list();
        expect(isOk(list)).toBe(true);
        if (isOk(list)) {
          expect(list.value.total).toBe(1);
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 24 — Operations on absent primary keys are not-found and inert
// ---------------------------------------------------------------------------

describe('CRUD runtime property 24 (Req 5.7)', () => {
  it('Feature: ai-database-architect, Property 24: Operations on absent primary keys are not-found and inert', () => {
    fc.assert(
      fc.property(
        entityBPArb(0).chain((bp) =>
          fc
            .tuple(
              fc.array(validPayloadArb(bp), { maxLength: 6 }),
              validPayloadArb(bp),
              fc.string({ minLength: 1, maxLength: 16 }),
            )
            .map(([seedPayloads, updatePayload, absentSuffix]) => ({
              bp,
              seedPayloads,
              updatePayload,
              // A key value that cannot collide with an assigned UUID.
              absentKey: `absent-pk-${absentSuffix}`,
            })),
        ),
        ({ bp, seedPayloads, updatePayload, absentKey }) => {
          const crud = buildCrudSet(singleEntityModel(bp), createInMemoryStore()).get(
            bp.name,
          )!;

          // Seed an arbitrary number of valid records.
          for (const payload of seedPayloads) {
            crud.create(payload);
          }

          const before = crud.list({ size: MAX_PAGE_SIZE });
          expect(isOk(before)).toBe(true);
          if (!isOk(before)) return;
          const snapshot = JSON.stringify(before.value.records);
          const totalBefore = before.value.total;

          // read / update / delete on an absent key all return NOT_FOUND.
          const read = crud.read(absentKey);
          expect(isErr(read)).toBe(true);
          if (isErr(read)) expect(read.error.kind).toBe('NOT_FOUND');

          const update = crud.update(absentKey, updatePayload);
          expect(isErr(update)).toBe(true);
          if (isErr(update)) expect(update.error.kind).toBe('NOT_FOUND');

          const del = crud.delete(absentKey);
          expect(isErr(del)).toBe(true);
          if (isErr(del)) expect(del.error.kind).toBe('NOT_FOUND');

          // Stored data is unchanged.
          const after = crud.list({ size: MAX_PAGE_SIZE });
          expect(isOk(after)).toBe(true);
          if (!isOk(after)) return;
          expect(after.value.total).toBe(totalBefore);
          expect(JSON.stringify(after.value.records)).toBe(snapshot);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 25 — Default list pagination
// ---------------------------------------------------------------------------

describe('CRUD runtime property 25 (Req 5.8)', () => {
  it('Feature: ai-database-architect, Property 25: Default list pagination', () => {
    fc.assert(
      fc.property(
        entityBPArb(0).chain((bp) =>
          fc
            .array(validPayloadArb(bp), { maxLength: 40 })
            .map((payloads) => ({ bp, payloads })),
        ),
        ({ bp, payloads }) => {
          const crud = buildCrudSet(singleEntityModel(bp), createInMemoryStore()).get(
            bp.name,
          )!;

          // Persist what we can (UNIQUE collisions, if any, simply fail).
          const persisted: EntityRecord[] = [];
          for (const payload of payloads) {
            const r = crud.create(payload);
            if (isOk(r)) persisted.push(r.value);
          }

          const result = crud.list();
          expect(isOk(result)).toBe(true);
          if (!isOk(result)) return;
          const page = result.value;

          // Defaults: page 1, page size 25.
          expect(page.page).toBe(1);
          expect(page.pageSize).toBe(DEFAULT_PAGE_SIZE);
          expect(page.total).toBe(persisted.length);

          // At most 25 records, equal to the first 25 of PK-ascending order.
          expect(page.records.length).toBe(Math.min(DEFAULT_PAGE_SIZE, persisted.length));
          const expectedIds = [...persisted]
            .sort(byUuidAscending)
            .slice(0, DEFAULT_PAGE_SIZE)
            .map((r) => r.id);
          expect(page.records.map((r) => r.id)).toEqual(expectedIds);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 26 — List/display page size bounds
// ---------------------------------------------------------------------------

describe('CRUD runtime property 26 (Req 5.9, 7.2)', () => {
  it('Feature: ai-database-architect, Property 26: List/display page size bounds', () => {
    fc.assert(
      fc.property(
        modelArb,
        fc.integer({ min: -5, max: 130 }),
        ({ model, entityBPs }, size) => {
          const crudSet = buildCrudSet(model, createInMemoryStore());
          const crud = crudSet.get(entityBPs[0].name)!;

          const result = crud.list({ size });
          const shouldReject = size < MIN_PAGE_SIZE || size > MAX_PAGE_SIZE;

          // Rejected iff size is outside [1, 100].
          expect(isErr(result)).toBe(shouldReject);
          if (shouldReject) {
            if (isErr(result)) {
              expect(result.error.kind).toBe('VALIDATION_ERROR');
            }
          } else {
            if (isOk(result)) {
              expect(result.value.pageSize).toBe(size);
            }
          }

          // Every generated dashboard entity view uses page size <= 100.
          const descriptor = generateDescriptor(model);
          for (const view of descriptor.entities) {
            expect(view.pageSize).toBeLessThanOrEqual(MAX_PAGE_SIZE);
          }
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});
