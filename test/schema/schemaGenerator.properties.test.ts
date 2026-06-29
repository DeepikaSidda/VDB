/**
 * Property-based tests for the Schema_Generator (tasks 3.3–3.8) plus a focused
 * unit test for the unmappable-type path (task 3.9).
 *
 * Framework: vitest + fast-check (min 100 iterations per property, per the
 * design's Testing Strategy). Each property test is tagged exactly:
 *   `Feature: ai-database-architect, Property {n}: {property_text}`
 *
 * Component under test: src/schema/schemaGenerator.ts `generate`.
 *
 * Strategy: a `validModelArb` produces valid, acyclic Data_Models — every
 * entity has a surrogate UUID `id` primary key, varied plain attributes drawn
 * from the supported DataType set, and foreign-key columns that only reference
 * earlier-declared entities (guaranteeing referential closure and acyclicity).
 * Targeted generators deliberately introduce the error conditions (dangling
 * references, unmappable types, cyclic FK graphs) for the negative properties.
 */

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import type {
  Attribute,
  DataModel,
  DataType,
  Entity,
  Relationship,
} from '../../src/model/types.js';
import { isErr } from '../../src/model/result.js';
import { generate } from '../../src/schema/schemaGenerator.js';

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

const NUM_RUNS = 100;

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

/** Data types deliberately outside the supported set (Req 3.8 triggers). */
const UNMAPPABLE_TYPES = ['GEOMETRY', 'POINT', 'BLOB', 'XML', 'ENUM', 'ARRAY'];

const dataTypeArb = fc.constantFrom(...SUPPORTED_DATA_TYPES);

type PlainAttrSpec = { dataType: DataType; notNull: boolean; unique: boolean };

const plainAttrArb: fc.Arbitrary<PlainAttrSpec> = fc.record({
  dataType: dataTypeArb,
  notNull: fc.boolean(),
  unique: fc.boolean(),
});

type EntitySpec = {
  plainAttrs: PlainAttrSpec[];
  /** Indices of earlier-declared entities this entity has an FK to. */
  fkTargets: number[];
  cardinality: 'ONE_TO_ONE' | 'ONE_TO_MANY';
};

function earlierIndices(index: number): number[] {
  return Array.from({ length: index }, (_, k) => k);
}

function entitySpecArb(index: number): fc.Arbitrary<EntitySpec> {
  return fc.record({
    plainAttrs: fc.array(plainAttrArb, { maxLength: 3 }),
    fkTargets:
      index === 0
        ? fc.constant<number[]>([])
        : fc.subarray(earlierIndices(index)),
    cardinality: fc.constantFrom<'ONE_TO_ONE' | 'ONE_TO_MANY'>(
      'ONE_TO_ONE',
      'ONE_TO_MANY',
    ),
  });
}

/** Count the FK columns in a model (attributes carrying a FOREIGN_KEY). */
function countForeignKeyColumns(model: DataModel): number {
  let count = 0;
  for (const entity of model.entities) {
    for (const attr of entity.attributes) {
      if (attr.constraints.some((c) => c.kind === 'FOREIGN_KEY')) count += 1;
    }
  }
  return count;
}

/** All FK edges in the model as (referencing entity -> referenced entity). */
function foreignKeyEdges(
  model: DataModel,
): { from: string; to: string; column: string }[] {
  const edges: { from: string; to: string; column: string }[] = [];
  for (const entity of model.entities) {
    for (const attr of entity.attributes) {
      for (const c of attr.constraints) {
        if (c.kind === 'FOREIGN_KEY') {
          edges.push({
            from: entity.name,
            to: c.references.entity,
            column: attr.name,
          });
        }
      }
    }
  }
  return edges;
}

/** Build a valid, acyclic Data_Model from per-entity specs. */
function buildValidModel(specs: EntitySpec[], ensureFk: boolean): DataModel {
  const names = specs.map((_, i) => `E${i}`);

  const entities: Entity[] = specs.map((spec, i) => {
    const attributes: Attribute[] = [
      { name: 'id', dataType: 'UUID', constraints: [] },
    ];
    spec.plainAttrs.forEach((p, j) => {
      const constraints: Attribute['constraints'] = [];
      if (p.notNull) constraints.push({ kind: 'NOT_NULL' });
      if (p.unique) constraints.push({ kind: 'UNIQUE' });
      attributes.push({ name: `a${i}_${j}`, dataType: p.dataType, constraints });
    });
    spec.fkTargets.forEach((k) => {
      attributes.push({
        name: `fk_${i}_${k}`,
        dataType: 'UUID',
        constraints: [
          {
            kind: 'FOREIGN_KEY',
            references: { entity: names[k], attribute: 'id' },
          },
        ],
      });
    });
    return { name: names[i], attributes, primaryKey: ['id'], isJoinEntity: false };
  });

  const relationships: Relationship[] = [];
  specs.forEach((spec, i) => {
    spec.fkTargets.forEach((k) => {
      relationships.push({
        source: names[i],
        target: names[k],
        cardinality: spec.cardinality,
      });
    });
  });

  const model: DataModel = { entities, relationships };

  // For properties that need at least one FK, force E1 -> E0 when the random
  // draw produced none.
  if (ensureFk && countForeignKeyColumns(model) === 0 && entities.length >= 2) {
    entities[1].attributes.push({
      name: 'fk_1_0',
      dataType: 'UUID',
      constraints: [
        { kind: 'FOREIGN_KEY', references: { entity: names[0], attribute: 'id' } },
      ],
    });
    relationships.push({
      source: names[1],
      target: names[0],
      cardinality: 'ONE_TO_MANY',
    });
  }

  return model;
}

function validModelArb(
  opts: { minEntities?: number; maxEntities?: number; ensureFk?: boolean } = {},
): fc.Arbitrary<DataModel> {
  const { minEntities = 1, maxEntities = 6, ensureFk = false } = opts;
  return fc
    .integer({ min: minEntities, max: maxEntities })
    .chain((count) =>
      fc
        .tuple(...Array.from({ length: count }, (_, i) => entitySpecArb(i)))
        .map((specs) => buildValidModel(specs as EntitySpec[], ensureFk)),
    );
}

function clone(model: DataModel): DataModel {
  return JSON.parse(JSON.stringify(model)) as DataModel;
}

// ---------------------------------------------------------------------------
// Property 9 — Relationships produce foreign-key constraints to target PK
// ---------------------------------------------------------------------------

describe('Schema_Generator property 9 (Req 2.5, 3.3)', () => {
  it('Feature: ai-database-architect, Property 9: Relationships produce foreign-key constraints to the target primary key', () => {
    fc.assert(
      fc.property(
        validModelArb({ minEntities: 2, maxEntities: 6, ensureFk: true }),
        (model) => {
          const result = generate(model, 'POSTGRES');
          // Valid acyclic model => success.
          expect(result.ok).toBe(true);
          if (!result.ok) return;

          const script = result.value;
          const addFkStatements = script.statements.filter(
            (s) => s.kind === 'ADD_FK',
          );

          // For every FK column, an ADD_FK statement references the target
          // entity's primary-key attribute ("id").
          for (const edge of foreignKeyEdges(model)) {
            const match = addFkStatements.find(
              (s) =>
                s.sql.includes(`ALTER TABLE "${edge.from}"`) &&
                s.sql.includes(`FOREIGN KEY ("${edge.column}")`) &&
                s.sql.includes(`REFERENCES "${edge.to}" ("id")`),
            );
            expect(match).toBeDefined();
          }
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 10 — Exactly one index per foreign-key column
// ---------------------------------------------------------------------------

describe('Schema_Generator property 10 (Req 3.5)', () => {
  it('Feature: ai-database-architect, Property 10: Exactly one index per foreign-key column', () => {
    fc.assert(
      fc.property(
        validModelArb({ minEntities: 1, maxEntities: 6 }),
        (model) => {
          const result = generate(model, 'POSTGRES');
          expect(result.ok).toBe(true);
          if (!result.ok) return;

          const indexCount = result.value.statements.filter(
            (s) => s.kind === 'CREATE_INDEX',
          ).length;
          expect(indexCount).toBe(countForeignKeyColumns(model));
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 11 — Migration script is topologically ordered
// ---------------------------------------------------------------------------

function createTableIndex(
  statements: { sql: string; kind: string }[],
  entityName: string,
): number {
  return statements.findIndex(
    (s) =>
      s.kind === 'CREATE_TABLE' &&
      s.sql.includes(`CREATE TABLE "${entityName}"`),
  );
}

describe('Schema_Generator property 11 (Req 3.6)', () => {
  it('Feature: ai-database-architect, Property 11: Migration script is topologically ordered', () => {
    fc.assert(
      fc.property(
        validModelArb({ minEntities: 1, maxEntities: 6, ensureFk: true }),
        (model) => {
          const result = generate(model, 'POSTGRES');
          expect(result.ok).toBe(true);
          if (!result.ok) return;

          const { statements } = result.value;
          // Every referenced table's CREATE TABLE precedes the referencing one.
          for (const edge of foreignKeyEdges(model)) {
            if (edge.from === edge.to) continue; // self-FK is not an edge
            const referencedIdx = createTableIndex(statements, edge.to);
            const referencingIdx = createTableIndex(statements, edge.from);
            expect(referencedIdx).toBeGreaterThanOrEqual(0);
            expect(referencingIdx).toBeGreaterThanOrEqual(0);
            expect(referencedIdx).toBeLessThan(referencingIdx);
          }
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 12 — Dangling relationship targets are rejected
// ---------------------------------------------------------------------------

const GHOST = 'GHOST_UNDEFINED';

const danglingModelArb: fc.Arbitrary<{ model: DataModel; ghost: string }> = fc
  .tuple(validModelArb({ minEntities: 1, maxEntities: 5 }), fc.boolean())
  .map(([base, asForeignKey]) => {
    const model = clone(base);
    const firstEntity = model.entities[0].name;
    if (asForeignKey) {
      model.entities[0].attributes.push({
        name: 'dangling_fk',
        dataType: 'UUID',
        constraints: [
          { kind: 'FOREIGN_KEY', references: { entity: GHOST, attribute: 'id' } },
        ],
      });
    } else {
      model.relationships.push({
        source: firstEntity,
        target: GHOST,
        cardinality: 'ONE_TO_MANY',
      });
    }
    return { model, ghost: GHOST };
  });

describe('Schema_Generator property 12 (Req 3.7)', () => {
  it('Feature: ai-database-architect, Property 12: Dangling relationship targets are rejected', () => {
    fc.assert(
      fc.property(danglingModelArb, ({ model, ghost }) => {
        const result = generate(model, 'POSTGRES');
        expect(isErr(result)).toBe(true);
        // No migration script is emitted on failure.
        expect('value' in result).toBe(false);
        if (isErr(result)) {
          expect(result.error.kind).toBe('UNDEFINED_ENTITY');
          if (result.error.kind === 'UNDEFINED_ENTITY') {
            expect(result.error.entity).toBe(ghost);
          }
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 13 — Unorderable cyclic dependencies are rejected
// ---------------------------------------------------------------------------

const cyclicModelArb: fc.Arbitrary<{ model: DataModel; ring: string[] }> = fc
  .tuple(fc.integer({ min: 2, max: 4 }), fc.nat({ max: 2 }))
  .map(([ringSize, extra]) => {
    const ring = Array.from({ length: ringSize }, (_, i) => `R${i}`);
    const entities: Entity[] = ring.map((name, i) => {
      const next = ring[(i + 1) % ringSize];
      return {
        name,
        attributes: [
          { name: 'id', dataType: 'UUID', constraints: [] },
          {
            name: `fk_to_${next}`,
            dataType: 'UUID',
            constraints: [
              {
                kind: 'FOREIGN_KEY',
                references: { entity: next, attribute: 'id' },
              },
            ],
          },
        ],
        primaryKey: ['id'],
        isJoinEntity: false,
      };
    });
    // Independent acyclic entities that must NOT appear in the reported cycle.
    for (let j = 0; j < extra; j++) {
      entities.push({
        name: `S${j}`,
        attributes: [{ name: 'id', dataType: 'UUID', constraints: [] }],
        primaryKey: ['id'],
        isJoinEntity: false,
      });
    }
    return { model: { entities, relationships: [] }, ring };
  });

describe('Schema_Generator property 13 (Req 3.9)', () => {
  it('Feature: ai-database-architect, Property 13: Unorderable cyclic dependencies are rejected', () => {
    fc.assert(
      fc.property(cyclicModelArb, ({ model, ring }) => {
        const result = generate(model, 'POSTGRES');
        expect(isErr(result)).toBe(true);
        // No migration script is emitted on failure.
        expect('value' in result).toBe(false);
        if (isErr(result)) {
          expect(result.error.kind).toBe('CYCLIC_DEPENDENCY');
          if (result.error.kind === 'CYCLIC_DEPENDENCY') {
            // Every ring member is named among the cycle entities.
            for (const name of ring) {
              expect(result.error.entities).toContain(name);
            }
          }
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 14 — Errors leave no partial output (fail closed)
// ---------------------------------------------------------------------------

const unmappableModelArb: fc.Arbitrary<DataModel> = fc
  .tuple(
    validModelArb({ minEntities: 1, maxEntities: 5 }),
    fc.constantFrom(...UNMAPPABLE_TYPES),
  )
  .map(([base, badType]) => {
    const model = clone(base);
    model.entities[0].attributes.push({
      name: 'bad_col',
      dataType: badType as DataType,
      constraints: [],
    });
    return model;
  });

const anyErroringModelArb: fc.Arbitrary<DataModel> = fc.oneof(
  danglingModelArb.map(({ model }) => model),
  unmappableModelArb,
  cyclicModelArb.map(({ model }) => model),
);

describe('Schema_Generator property 14 (Req 3.10)', () => {
  it('Feature: ai-database-architect, Property 14: Errors leave no partial output (fail closed)', () => {
    fc.assert(
      fc.property(anyErroringModelArb, (model) => {
        const result = generate(model, 'POSTGRES');
        expect(isErr(result)).toBe(true);
        // Fail closed: the Err carries no migration script / statements at all.
        expect('value' in result).toBe(false);
      }),
      { numRuns: NUM_RUNS },
    );
  });
});

// ---------------------------------------------------------------------------
// Task 3.9 — focused unit test for the unmappable data-type path (Req 3.8)
// ---------------------------------------------------------------------------

describe('Schema_Generator unmappable type (task 3.9, Req 3.8)', () => {
  it('returns UNMAPPABLE_TYPE identifying the column and type and emits no DDL', () => {
    const model: DataModel = {
      entities: [
        {
          name: 'Place',
          attributes: [
            { name: 'id', dataType: 'UUID', constraints: [] },
            // Intentionally outside the supported DataType set (Req 3.8).
            { name: 'location', dataType: 'GEOMETRY' as DataType, constraints: [] },
          ],
          primaryKey: ['id'],
          isJoinEntity: false,
        },
      ],
      relationships: [],
    };

    const result = generate(model, 'POSTGRES');

    expect(isErr(result)).toBe(true);
    // Fail closed: no migration script is produced.
    expect('value' in result).toBe(false);
    if (isErr(result)) {
      expect(result.error.kind).toBe('UNMAPPABLE_TYPE');
      if (result.error.kind === 'UNMAPPABLE_TYPE') {
        expect(result.error.entity).toBe('Place');
        expect(result.error.attribute).toBe('location');
        expect(result.error.dataType).toBe('GEOMETRY');
      }
    }
  });
});
