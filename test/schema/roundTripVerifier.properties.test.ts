/**
 * Property-based tests for the Round-Trip Verifier (tasks 4.3–4.6).
 *
 * These exercise the generate -> parseDDL -> compare round trip across a large
 * space of VALID Data_Models:
 *
 *   Property 15 (task 4.3) — round-trip preserves entities       (Req 12.2, 12.1)
 *   Property 16 (task 4.4) — round-trip preserves relationships  (Req 12.3)
 *   Property 17 (task 4.5) — round-trip preserves constraints    (Req 12.1, 12.4,
 *                                                                  3.1, 3.2, 3.4,
 *                                                                  2.1, 2.2)
 *   Property 18 (task 4.6) — round-trip mismatch fails closed    (Req 12.5)
 *
 * The comparison conventions documented in `roundTripVerifier.ts` are honored
 * exactly: entity equality is name + attribute `name:dataType` set; relationship
 * equality is the FK-derived edge set (NOT the raw `relationships` array); and
 * constraint equality is the normalized projection (PK via `entity.primaryKey`,
 * plus NOT_NULL / UNIQUE / FOREIGN_KEY). The shared exported helpers
 * `relationshipEdges` and `constraintProjection` are used so the test compares
 * on the same basis the verifier does.
 */

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import type {
  Attribute,
  AttributeConstraint,
  DataModel,
  DataType,
  Entity,
  Relationship,
} from '../../src/model/types.js';
import { isOk, isErr, unwrap } from '../../src/model/result.js';
import { generate } from '../../src/schema/schemaGenerator.js';
import {
  parseDDL,
  verify,
  relationshipEdges,
  constraintProjection,
  type RoundTripDiff,
  type ConstraintProjection,
} from '../../src/schema/roundTripVerifier.js';

const NUM_RUNS = 200;

/** The supported attribute data types (each maps bijectively to a PG type). */
const DATA_TYPES: DataType[] = [
  'UUID', 'TEXT', 'VARCHAR', 'INTEGER', 'BIGINT',
  'NUMERIC', 'BOOLEAN', 'DATE', 'TIMESTAMP', 'JSON',
];

// ---------------------------------------------------------------------------
// Arbitrary: VALID Data_Models that generate() accepts and that round-trip.
//
// Shape produced (all invariants the Schema_Generator requires):
//   - entities E0..E{n-1}, each with a single UUID `id` primary key;
//   - 0..3 extra attributes of varied types, optionally NOT_NULL and/or UNIQUE;
//   - FK columns referencing only EARLIER entities' `id` PKs (acyclic graph),
//     each with a matching ONE_TO_MANY relationship;
//   - optionally a MANY_TO_MANY join entity `J` whose composite PK is two FK
//     columns referencing two existing entities' `id` PKs.
// ---------------------------------------------------------------------------

type ExtraSpec = { type: DataType; notNull: boolean; unique: boolean };
type EntitySpec = { extras: ExtraSpec[]; fkTargets: number[] };
type ModelSpec = {
  entities: EntitySpec[];
  join?: { a: number; b: number };
};

function extraArb(): fc.Arbitrary<ExtraSpec> {
  return fc.record({
    type: fc.constantFrom(...DATA_TYPES),
    notNull: fc.boolean(),
    unique: fc.boolean(),
  });
}

function entitySpecArb(index: number): fc.Arbitrary<EntitySpec> {
  return fc.record({
    extras: fc.array(extraArb(), { maxLength: 3 }),
    fkTargets:
      index === 0
        ? fc.constant<number[]>([])
        : fc.uniqueArray(fc.integer({ min: 0, max: index - 1 }), {
            maxLength: index,
          }),
  });
}

function buildModel(n: number, spec: ModelSpec): DataModel {
  const entities: Entity[] = [];
  const relationships: Relationship[] = [];

  spec.entities.forEach((eSpec, i) => {
    const name = `E${i}`;
    const attributes: Attribute[] = [
      { name: 'id', dataType: 'UUID', constraints: [] },
    ];

    eSpec.extras.forEach((ex, k) => {
      const constraints: AttributeConstraint[] = [];
      if (ex.notNull) {
        constraints.push({ kind: 'NOT_NULL' });
      }
      if (ex.unique) {
        constraints.push({ kind: 'UNIQUE' });
      }
      attributes.push({ name: `a${k}`, dataType: ex.type, constraints });
    });

    for (const t of eSpec.fkTargets) {
      attributes.push({
        name: `fk_E${t}`,
        dataType: 'UUID',
        constraints: [
          { kind: 'FOREIGN_KEY', references: { entity: `E${t}`, attribute: 'id' } },
        ],
      });
      relationships.push({ source: name, target: `E${t}`, cardinality: 'ONE_TO_MANY' });
    }

    entities.push({ name, attributes, primaryKey: ['id'], isJoinEntity: false });
  });

  if (spec.join !== undefined && n >= 2) {
    const a = spec.join.a % n;
    let b = spec.join.b % n;
    if (a === b) {
      b = (b + 1) % n;
    }
    const attributes: Attribute[] = [
      {
        name: `fk_E${a}`,
        dataType: 'UUID',
        constraints: [
          { kind: 'FOREIGN_KEY', references: { entity: `E${a}`, attribute: 'id' } },
        ],
      },
      {
        name: `fk_E${b}`,
        dataType: 'UUID',
        constraints: [
          { kind: 'FOREIGN_KEY', references: { entity: `E${b}`, attribute: 'id' } },
        ],
      },
    ];
    entities.push({
      name: 'J',
      attributes,
      primaryKey: [`fk_E${a}`, `fk_E${b}`],
      isJoinEntity: true,
    });
    relationships.push({ source: `E${a}`, target: `E${b}`, cardinality: 'MANY_TO_MANY' });
  }

  return { entities, relationships };
}

function validDataModelArb(): fc.Arbitrary<DataModel> {
  return fc.integer({ min: 2, max: 5 }).chain((n) =>
    fc
      .record({
        entities: fc.tuple(
          ...Array.from({ length: n }, (_unused, i) => entitySpecArb(i)),
        ),
        join: fc.option(
          fc.record({ a: fc.nat({ max: 20 }), b: fc.nat({ max: 20 }) }),
          { nil: undefined },
        ),
      })
      .map((spec) =>
        buildModel(n, {
          entities: spec.entities as EntitySpec[],
          join: spec.join ?? undefined,
        }),
      ),
  );
}

// ---------------------------------------------------------------------------
// Comparison helpers mirroring the verifier's documented conventions.
// ---------------------------------------------------------------------------

/** Entity signature set: `name|<sorted name:dataType tokens>` per entity. */
function entitySignatureSet(model: DataModel): string[] {
  return model.entities
    .map((e) => {
      const sig = e.attributes
        .map((a) => `${a.name}:${a.dataType}`)
        .sort()
        .join('\u0000');
      return `${e.name}|${sig}`;
    })
    .sort();
}

/** Stable key for an FK-derived relationship edge. */
function edgeKey(edge: { source: string; target: string; attribute: string }): string {
  return `${edge.source} -> ${edge.target} (${edge.attribute})`;
}

/** Normalize a ConstraintProjection into deeply-comparable plain data. */
function normalizeProjection(proj: ConstraintProjection): {
  primaryKeys: [string, string][];
  notNull: string[];
  unique: string[];
  foreignKeys: string[];
} {
  return {
    primaryKeys: [...proj.primaryKeys.entries()]
      .map(([entity, pk]) => [entity, pk.join(',')] as [string, string])
      .sort((x, y) => (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0)),
    notNull: [...proj.notNull].sort(),
    unique: [...proj.unique].sort(),
    foreignKeys: [...proj.foreignKeys].sort(),
  };
}

// ---------------------------------------------------------------------------
// Property 15 — Round-trip preserves entities (task 4.3)
// ---------------------------------------------------------------------------

describe('Round-Trip Verifier — entity preservation (Property 15)', () => {
  // **Validates: Requirements 12.2, 12.1**
  it('Feature: ai-database-architect, Property 15: Round-trip preserves entities', () => {
    fc.assert(
      fc.property(validDataModelArb(), (model) => {
        const gen = generate(model);
        expect(isOk(gen)).toBe(true);
        const ddl = unwrap(gen);

        // Round-trip success: verify accepts the faithful generate -> parse.
        expect(isOk(verify(ddl, model))).toBe(true);

        // Precise: parsed entity set (name + attribute name:type set) == source,
        // and table count == entity count (Req 12.1).
        const parsed = parseDDL(ddl);
        expect(entitySignatureSet(parsed)).toEqual(entitySignatureSet(model));
        expect(parsed.entities.length).toBe(model.entities.length);
      }),
      { numRuns: NUM_RUNS },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 16 — Round-trip preserves relationships (task 4.4)
// ---------------------------------------------------------------------------

describe('Round-Trip Verifier — relationship preservation (Property 16)', () => {
  // **Validates: Requirements 12.3**
  it('Feature: ai-database-architect, Property 16: Round-trip preserves relationships', () => {
    fc.assert(
      fc.property(validDataModelArb(), (model) => {
        const gen = generate(model);
        expect(isOk(gen)).toBe(true);
        const ddl = unwrap(gen);

        expect(isOk(verify(ddl, model))).toBe(true);

        // Precise: the FK-derived relationship edge sets are equal. Per the
        // module convention we compare relationshipEdges, NOT the raw arrays.
        const parsed = parseDDL(ddl);
        const sourceEdges = relationshipEdges(model).map(edgeKey).sort();
        const parsedEdges = relationshipEdges(parsed).map(edgeKey).sort();
        expect(parsedEdges).toEqual(sourceEdges);
      }),
      { numRuns: NUM_RUNS },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 17 — Round-trip preserves constraints (task 4.5)
// ---------------------------------------------------------------------------

describe('Round-Trip Verifier — constraint preservation (Property 17)', () => {
  // **Validates: Requirements 12.1, 12.4, 3.1, 3.2, 3.4, 2.1, 2.2**
  it('Feature: ai-database-architect, Property 17: Round-trip preserves constraints', () => {
    fc.assert(
      fc.property(validDataModelArb(), (model) => {
        const gen = generate(model);
        expect(isOk(gen)).toBe(true);
        const ddl = unwrap(gen);

        expect(isOk(verify(ddl, model))).toBe(true);

        // Precise: PK (via entity.primaryKey), NOT_NULL, UNIQUE, and FOREIGN_KEY
        // projections are equal, and table count == entity count (Req 12.1).
        const parsed = parseDDL(ddl);
        expect(normalizeProjection(constraintProjection(parsed))).toEqual(
          normalizeProjection(constraintProjection(model)),
        );
        expect(parsed.entities.length).toBe(model.entities.length);
      }),
      { numRuns: NUM_RUNS },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 18 — Round-trip mismatch fails closed (task 4.6)
// ---------------------------------------------------------------------------

/** Deep clone via JSON (the models are plain JSON-safe data). */
function clone(model: DataModel): DataModel {
  return JSON.parse(JSON.stringify(model)) as DataModel;
}

/** Locate the first FOREIGN_KEY constraint in the model, if any. */
function findFirstForeignKey(
  model: DataModel,
): { entity: string; column: string } | undefined {
  for (const entity of model.entities) {
    for (const attribute of entity.attributes) {
      if (attribute.constraints.some((c) => c.kind === 'FOREIGN_KEY')) {
        return { entity: entity.name, column: attribute.name };
      }
    }
  }
  return undefined;
}

/** A single-element mutation plus the token that must appear in the diff. */
type Mutation = { token: string; apply: () => DataModel };

/**
 * Build the set of applicable single-element mutations for a model. Each adds,
 * loses, or alters exactly one element the verifier compares, so each MUST
 * produce a non-empty diff naming `token`.
 */
function buildMutations(model: DataModel): Mutation[] {
  const mutations: Mutation[] = [];

  // (1) Alter an attribute's data type: flip E0.id's type. E0 is present in
  // both sides, so this surfaces as an altered entity.
  mutations.push({
    token: 'E0',
    apply: () => {
      const m = clone(model);
      const e = m.entities.find((x) => x.name === 'E0')!;
      const idAttr = e.attributes.find((a) => a.name === 'id')!;
      idAttr.dataType = idAttr.dataType === 'UUID' ? 'TEXT' : 'UUID';
      return m;
    },
  });

  // (2) Drop an entity: remove the last entity (never an FK target, since FKs
  // only point at earlier entities), so the source loses an entity present in
  // the DDL.
  if (model.entities.length >= 2) {
    const lastName = model.entities[model.entities.length - 1].name;
    mutations.push({
      token: lastName,
      apply: () => {
        const m = clone(model);
        m.entities = m.entities.filter((e) => e.name !== lastName);
        m.relationships = m.relationships.filter(
          (r) => r.source !== lastName && r.target !== lastName,
        );
        return m;
      },
    });
  }

  // (3) Add an extra entity to the source that the DDL never produced.
  mutations.push({
    token: 'GHOSTX',
    apply: () => {
      const m = clone(model);
      m.entities.push({
        name: 'GHOSTX',
        attributes: [{ name: 'id', dataType: 'UUID', constraints: [] }],
        primaryKey: ['id'],
        isJoinEntity: false,
      });
      return m;
    },
  });

  // (4) Drop a foreign-key constraint (keep the column), if the model has one.
  const fk = findFirstForeignKey(model);
  if (fk !== undefined) {
    mutations.push({
      token: fk.column,
      apply: () => {
        const m = clone(model);
        const e = m.entities.find((x) => x.name === fk.entity)!;
        const a = e.attributes.find((at) => at.name === fk.column)!;
        a.constraints = a.constraints.filter((c) => c.kind !== 'FOREIGN_KEY');
        return m;
      },
    });
  }

  return mutations;
}

/** Flatten every string the diff carries (message + all element lists). */
function allDiffStrings(diff: RoundTripDiff): string {
  const parts: string[] = [diff.message];
  for (const group of [diff.entities, diff.relationships, diff.constraints]) {
    if (group !== undefined) {
      parts.push(...group.added, ...group.lost, ...group.altered);
    }
  }
  return parts.join(' || ');
}

describe('Round-Trip Verifier — mismatch fails closed (Property 18)', () => {
  // **Validates: Requirements 12.5**
  it('Feature: ai-database-architect, Property 18: Round-trip mismatch fails closed', () => {
    fc.assert(
      fc.property(validDataModelArb(), fc.nat(), (model, seed) => {
        // The DDL is generated from the ORIGINAL (valid) model.
        const gen = generate(model);
        expect(isOk(gen)).toBe(true);
        const ddl = unwrap(gen);

        // Verify the DDL against a source that differs by exactly one element.
        const mutations = buildMutations(model);
        const mutation = mutations[seed % mutations.length];
        const mutated = mutation.apply();
        const snapshot = JSON.stringify(mutated);

        const result = verify(ddl, mutated);

        // Fails closed, naming the specific differing element ...
        expect(isErr(result)).toBe(true);
        if (isErr(result)) {
          expect(allDiffStrings(result.error)).toContain(mutation.token);
        }

        // ... and leaves the source Data_Model unchanged (Req 12.5).
        expect(JSON.stringify(mutated)).toBe(snapshot);
      }),
      { numRuns: NUM_RUNS },
    );
  });
});
