/**
 * Property-based + edge tests for the DynamoDB unrepresented-element report
 * (task 15.5) [STRETCH].
 *
 * Feature: ai-database-architect, Property 46: DynamoDB reports unrepresented constraints and relationships
 *
 * **Validates: Requirements 13.3**
 *
 * Property text (design): *For any* Data_Model generated for the DynamoDB
 * target, every constraint or relationship that the generated table design
 * does not represent appears in the returned report.
 *
 * Strategy: generate Data_Models whose entities carry a mix of FOREIGN_KEY,
 * UNIQUE, NOT_NULL, FORMAT, and RANGE constraints plus relationships, then
 * assert that every such constraint/relationship the key-only DynamoDB design
 * cannot represent appears in `generateDynamoDbDesign(model).unrepresented`,
 * and that the PRIMARY_KEY (which the key schema *does* represent) is never
 * reported.
 */

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import type {
  Attribute,
  AttributeConstraint,
  DataModel,
  Entity,
  Relationship,
} from '../../src/model/types.js';
import { unwrap } from '../../src/model/result.js';
import {
  generateDynamoDbDesign,
  type UnrepresentedElement,
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

const cardinalityArb = fc.constantFrom<Relationship['cardinality']>(
  'ONE_TO_ONE', 'ONE_TO_MANY', 'MANY_TO_MANY',
);

type EntitySpec = {
  unique: boolean;
  notNull: boolean;
  format: boolean;
  range: boolean;
  fkTo: number | null;
};

const constrainedModelArb: fc.Arbitrary<DataModel> = fc
  .uniqueArray(identifierArb, { minLength: 1, maxLength: 5 })
  .chain((names) =>
    fc
      .record({
        specs: fc.tuple(
          ...names.map((_, i) =>
            fc.record<EntitySpec>({
              unique: fc.boolean(),
              notNull: fc.boolean(),
              format: fc.boolean(),
              range: fc.boolean(),
              fkTo:
                i === 0
                  ? fc.constant<number | null>(null)
                  : fc.option(fc.integer({ min: 0, max: i - 1 }), { nil: null }),
            }),
          ),
        ),
        rels: fc.array(
          fc.record({
            s: fc.integer({ min: 0, max: names.length - 1 }),
            t: fc.integer({ min: 0, max: names.length - 1 }),
            cardinality: cardinalityArb,
          }),
          { maxLength: 4 },
        ),
      })
      .map(({ specs, rels }) => buildModel(names, specs, rels)),
  );

function buildModel(
  names: string[],
  specs: EntitySpec[],
  rels: { s: number; t: number; cardinality: Relationship['cardinality'] }[],
): DataModel {
  const entities: Entity[] = names.map((name, i) => {
    const attributes: Attribute[] = [
      { name: 'id', dataType: 'UUID', constraints: [{ kind: 'PRIMARY_KEY' }] },
    ];
    const spec = specs[i];
    if (spec.unique) {
      attributes.push({ name: 'uattr', dataType: 'TEXT', constraints: [{ kind: 'UNIQUE' }] });
    }
    if (spec.notNull) {
      attributes.push({ name: 'nattr', dataType: 'TEXT', constraints: [{ kind: 'NOT_NULL' }] });
    }
    if (spec.format) {
      attributes.push({
        name: 'eattr',
        dataType: 'VARCHAR',
        constraints: [{ kind: 'FORMAT', format: 'EMAIL' }],
      });
    }
    if (spec.range) {
      attributes.push({
        name: 'rattr',
        dataType: 'INTEGER',
        constraints: [{ kind: 'RANGE', min: 0, max: 100 }],
      });
    }
    if (spec.fkTo !== null) {
      const j = spec.fkTo;
      attributes.push({
        name: 'fkattr',
        dataType: 'UUID',
        constraints: [
          { kind: 'FOREIGN_KEY', references: { entity: names[j], attribute: 'id' } },
        ],
      });
    }
    return { name, attributes, primaryKey: ['id'], isJoinEntity: false };
  });

  const relationships: Relationship[] = rels.map((r) => ({
    source: names[r.s],
    target: names[r.t],
    cardinality: r.cardinality,
  }));

  return { entities, relationships };
}

// ---------------------------------------------------------------------------
// Property 46
// ---------------------------------------------------------------------------

/** Does the report contain an attribute-scoped element of `kind` for entity.attribute? */
function reportHasAttribute(
  report: UnrepresentedElement[],
  kind: AttributeConstraint['kind'],
  entity: string,
  attribute: string,
): boolean {
  return report.some(
    (e) =>
      e.kind === kind &&
      'entity' in e &&
      e.entity === entity &&
      'attribute' in e &&
      e.attribute === attribute,
  );
}

describe('Property 46: DynamoDB reports unrepresented constraints and relationships (Req 13.3)', () => {
  it('reports every non-key constraint and relationship, and never the primary key', () => {
    fc.assert(
      fc.property(constrainedModelArb, (model) => {
        const { unrepresented } = unwrap(generateDynamoDbDesign(model));

        // Every non-PRIMARY_KEY attribute constraint must be reported.
        for (const entity of model.entities) {
          for (const attr of entity.attributes) {
            for (const c of attr.constraints) {
              if (c.kind === 'PRIMARY_KEY') {
                // The key schema represents it -> must NOT be reported.
                expect(
                  reportHasAttribute(
                    unrepresented,
                    'PRIMARY_KEY' as AttributeConstraint['kind'],
                    entity.name,
                    attr.name,
                  ),
                ).toBe(false);
                continue;
              }
              expect(
                reportHasAttribute(unrepresented, c.kind, entity.name, attr.name),
              ).toBe(true);
            }
          }
        }

        // Every relationship must be reported.
        for (const rel of model.relationships) {
          expect(
            unrepresented.some(
              (e) =>
                e.kind === 'RELATIONSHIP' &&
                e.source === rel.source &&
                e.target === rel.target,
            ),
          ).toBe(true);
        }

        // The report must never contain a PRIMARY_KEY entry.
        expect(unrepresented.some((e) => e.kind === ('PRIMARY_KEY' as string))).toBe(
          false,
        );
      }),
      { numRuns: 200 },
    );
  });
});

// ---------------------------------------------------------------------------
// Representative edge cases
// ---------------------------------------------------------------------------

describe('Property 46 — representative edge cases', () => {
  it('reports FK, UNIQUE, NOT_NULL, FORMAT, RANGE, and RELATIONSHIP but not PRIMARY_KEY', () => {
    const model: DataModel = {
      entities: [
        {
          name: 'customer',
          attributes: [
            { name: 'id', dataType: 'UUID', constraints: [{ kind: 'PRIMARY_KEY' }] },
          ],
          primaryKey: ['id'],
          isJoinEntity: false,
        },
        {
          name: 'order',
          attributes: [
            { name: 'id', dataType: 'UUID', constraints: [{ kind: 'PRIMARY_KEY' }] },
            { name: 'sku', dataType: 'TEXT', constraints: [{ kind: 'UNIQUE' }] },
            { name: 'note', dataType: 'TEXT', constraints: [{ kind: 'NOT_NULL' }] },
            { name: 'email', dataType: 'VARCHAR', constraints: [{ kind: 'FORMAT', format: 'EMAIL' }] },
            { name: 'qty', dataType: 'INTEGER', constraints: [{ kind: 'RANGE', min: 1, max: 9 }] },
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
      relationships: [{ source: 'order', target: 'customer', cardinality: 'ONE_TO_MANY' }],
    };

    const { unrepresented } = unwrap(generateDynamoDbDesign(model));
    const kinds = new Set(unrepresented.map((e) => e.kind));
    expect(kinds.has('FOREIGN_KEY')).toBe(true);
    expect(kinds.has('UNIQUE')).toBe(true);
    expect(kinds.has('NOT_NULL')).toBe(true);
    expect(kinds.has('FORMAT')).toBe(true);
    expect(kinds.has('RANGE')).toBe(true);
    expect(kinds.has('RELATIONSHIP')).toBe(true);
    expect([...kinds].some((k) => String(k) === 'PRIMARY_KEY')).toBe(false);
  });

  it('reports nothing for a key-only model with no extra constraints or relationships', () => {
    const model: DataModel = {
      entities: [
        {
          name: 'thing',
          attributes: [
            { name: 'id', dataType: 'UUID', constraints: [{ kind: 'PRIMARY_KEY' }] },
          ],
          primaryKey: ['id'],
          isJoinEntity: false,
        },
      ],
      relationships: [],
    };
    const { unrepresented } = unwrap(generateDynamoDbDesign(model));
    expect(unrepresented).toEqual([]);
  });
});
