/**
 * Property-based + edge tests for alternative target projections (task 15.4)
 * [STRETCH].
 *
 * Feature: ai-database-architect, Property 45: Alternative targets generate one table per entity with a primary key
 *
 * **Validates: Requirements 13.1, 13.2**
 *
 * Property text (design): *For any* Data_Model with the configured target set
 * to Aurora DSQL or DynamoDB, the generated design includes exactly one table
 * per entity, each with a designated primary key (and, for DSQL, each entity's
 * columns and column data types).
 *
 * Strategy: generate a valid acyclic Data_Model (each entity has a single `id`
 * primary key plus attributes; foreign keys only reference earlier entities so
 * the dependency graph is a DAG). For AURORA_DSQL assert exactly one
 * CREATE TABLE per entity, each carrying a PRIMARY KEY plus every column and
 * its mapped PostgreSQL type. For DYNAMODB assert exactly one table definition
 * per entity, each a JSON CreateTable with a TableName and a non-empty
 * KeySchema containing a HASH (partition) key.
 */

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import type {
  Attribute,
  DataModel,
  DataType,
  Entity,
} from '../../src/model/types.js';
import { isOk, unwrap } from '../../src/model/result.js';
import {
  generate,
  DATA_TYPE_TO_POSTGRES,
} from '../../src/schema/schemaGenerator.js';

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

const identifierArb: fc.Arbitrary<string> = fc
  .array(fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz'.split('')), {
    minLength: 3,
    maxLength: 8,
  })
  .map((cs) => cs.join(''));

const dataTypeArb: fc.Arbitrary<DataType> = fc.constantFrom<DataType>(
  'UUID', 'TEXT', 'VARCHAR', 'INTEGER', 'BIGINT',
  'NUMERIC', 'BOOLEAN', 'DATE', 'TIMESTAMP', 'JSON',
);

/**
 * A valid, acyclic Data_Model: distinct entity names, each with a single `id`
 * UUID primary key, 0–3 typed extra columns, and an optional foreign key that
 * only references an earlier entity (keeping the FK graph acyclic).
 */
const validModelArb: fc.Arbitrary<DataModel> = fc
  .uniqueArray(identifierArb, { minLength: 1, maxLength: 6 })
  .chain((names) =>
    fc
      .tuple(
        ...names.map((_, i) =>
          fc.record({
            extras: fc.array(dataTypeArb, { maxLength: 3 }),
            fkTo:
              i === 0
                ? fc.constant<number | null>(null)
                : fc.option(fc.integer({ min: 0, max: i - 1 }), { nil: null }),
          }),
        ),
      )
      .map((specs) => buildModel(names, specs)),
  );

function buildModel(
  names: string[],
  specs: { extras: DataType[]; fkTo: number | null }[],
): DataModel {
  const entities: Entity[] = names.map((name, i) => {
    const attributes: Attribute[] = [
      { name: 'id', dataType: 'UUID', constraints: [{ kind: 'PRIMARY_KEY' }] },
    ];
    specs[i].extras.forEach((dt, k) => {
      attributes.push({ name: `attr${k}`, dataType: dt, constraints: [] });
    });
    if (specs[i].fkTo !== null) {
      const j = specs[i].fkTo as number;
      attributes.push({
        name: `fk${j}`,
        dataType: 'UUID',
        constraints: [
          { kind: 'FOREIGN_KEY', references: { entity: names[j], attribute: 'id' } },
        ],
      });
    }
    return { name, attributes, primaryKey: ['id'], isJoinEntity: false };
  });
  return { entities, relationships: [] };
}

// ---------------------------------------------------------------------------
// Property 45
// ---------------------------------------------------------------------------

describe('Property 45: Alternative targets generate one table per entity with a primary key (Req 13.1, 13.2)', () => {
  it('AURORA_DSQL: exactly one CREATE TABLE per entity with PK, columns, and mapped types', () => {
    fc.assert(
      fc.property(validModelArb, (model) => {
        const result = generate(model, 'AURORA_DSQL');
        expect(isOk(result)).toBe(true);
        const script = unwrap(result);
        expect(script.target).toBe('AURORA_DSQL');

        const createTables = script.statements.filter(
          (s) => s.kind === 'CREATE_TABLE',
        );
        // Exactly one table per entity.
        expect(createTables.length).toBe(model.entities.length);

        for (const entity of model.entities) {
          const stmt = createTables.find((s) =>
            s.sql.includes(`CREATE TABLE "${entity.name}"`),
          );
          expect(stmt).toBeDefined();
          // Designated primary key.
          expect(stmt!.sql).toContain('PRIMARY KEY');
          // Every column and its mapped PostgreSQL data type.
          for (const attr of entity.attributes) {
            expect(stmt!.sql).toContain(`"${attr.name}"`);
            expect(stmt!.sql).toContain(DATA_TYPE_TO_POSTGRES[attr.dataType]);
          }
        }
      }),
      { numRuns: 100 },
    );
  });

  it('DYNAMODB: exactly one table definition per entity, each with a HASH primary key', () => {
    fc.assert(
      fc.property(validModelArb, (model) => {
        const result = generate(model, 'DYNAMODB');
        expect(isOk(result)).toBe(true);
        const script = unwrap(result);
        expect(script.target).toBe('DYNAMODB');

        const tableDefs = script.statements.filter(
          (s) => s.kind === 'CREATE_TABLE',
        );
        // Exactly one table per entity.
        expect(tableDefs.length).toBe(model.entities.length);

        const tableNames = new Set<string>();
        for (const stmt of tableDefs) {
          const def = JSON.parse(stmt.sql) as {
            TableName: string;
            KeySchema: { AttributeName: string; KeyType: string }[];
          };
          expect(typeof def.TableName).toBe('string');
          tableNames.add(def.TableName);
          // Designated primary key: a non-empty key schema with a HASH key.
          expect(def.KeySchema.length).toBeGreaterThan(0);
          expect(def.KeySchema.some((k) => k.KeyType === 'HASH')).toBe(true);
        }

        // One table definition per distinct entity.
        expect(tableNames).toEqual(new Set(model.entities.map((e) => e.name)));
      }),
      { numRuns: 100 },
    );
  });
});

// ---------------------------------------------------------------------------
// Representative edge cases
// ---------------------------------------------------------------------------

describe('Property 45 — representative edge cases', () => {
  const twoEntityModel: DataModel = {
    entities: [
      {
        name: 'customer',
        attributes: [
          { name: 'id', dataType: 'UUID', constraints: [{ kind: 'PRIMARY_KEY' }] },
          { name: 'email', dataType: 'VARCHAR', constraints: [] },
        ],
        primaryKey: ['id'],
        isJoinEntity: false,
      },
      {
        name: 'order',
        attributes: [
          { name: 'id', dataType: 'UUID', constraints: [{ kind: 'PRIMARY_KEY' }] },
          {
            name: 'customer_id',
            dataType: 'UUID',
            constraints: [
              { kind: 'FOREIGN_KEY', references: { entity: 'customer', attribute: 'id' } },
            ],
          },
        ],
        primaryKey: ['id'],
        isJoinEntity: false,
      },
    ],
    relationships: [],
  };

  it('AURORA_DSQL produces one CREATE TABLE per entity', () => {
    const script = unwrap(generate(twoEntityModel, 'AURORA_DSQL'));
    const creates = script.statements.filter((s) => s.kind === 'CREATE_TABLE');
    expect(creates.length).toBe(2);
  });

  it('DYNAMODB produces one table per entity each with a HASH key', () => {
    const script = unwrap(generate(twoEntityModel, 'DYNAMODB'));
    const defs = script.statements
      .filter((s) => s.kind === 'CREATE_TABLE')
      .map((s) => JSON.parse(s.sql));
    expect(defs.length).toBe(2);
    for (const def of defs) {
      expect(def.KeySchema.some((k: { KeyType: string }) => k.KeyType === 'HASH')).toBe(true);
    }
  });
});
