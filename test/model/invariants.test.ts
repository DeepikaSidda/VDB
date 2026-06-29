/**
 * Unit tests for the Data_Model invariant validators I1–I6 (task 1.4).
 *
 * Each invariant is exercised with at least one passing Data_Model and one
 * violating Data_Model, asserting that the violating case identifies the
 * offending element. `validateDataModel` is also checked to aggregate the
 * full set of violations.
 *
 * _Requirements: 1.2, 1.3, 1.4, 1.5, 2.5, 2.6_
 */

import { describe, it, expect } from 'vitest';
import type { DataModel, DataType, Entity } from '../../src/model/types.js';
import { isOk, isErr } from '../../src/model/result.js';
import {
  checkI1,
  checkI2,
  checkI3,
  checkI4,
  checkI5,
  checkI6,
  validateInvariant,
  validateDataModel,
  SUPPORTED_DATA_TYPES,
} from '../../src/model/invariants.js';

// ---------------------------------------------------------------------------
// Small builders
// ---------------------------------------------------------------------------

function userEntity(): Entity {
  return {
    name: 'User',
    attributes: [{ name: 'id', dataType: 'UUID', constraints: [] }],
    primaryKey: ['id'],
    isJoinEntity: false,
  };
}

function postEntity(): Entity {
  return {
    name: 'Post',
    attributes: [
      { name: 'id', dataType: 'UUID', constraints: [] },
      {
        name: 'authorId',
        dataType: 'UUID',
        constraints: [
          {
            kind: 'FOREIGN_KEY',
            references: { entity: 'User', attribute: 'id' },
          },
        ],
      },
    ],
    primaryKey: ['id'],
    isJoinEntity: false,
  };
}

/** A fully well-formed model used as the passing baseline for every check. */
function wellFormedModel(): DataModel {
  return {
    entities: [userEntity(), postEntity()],
    relationships: [
      { source: 'Post', target: 'User', cardinality: 'ONE_TO_MANY' },
    ],
  };
}

// ---------------------------------------------------------------------------
// I1 — single non-empty primary key per entity (Req 1.2, 2.6)
// ---------------------------------------------------------------------------

describe('I1 — single non-empty primary key per entity', () => {
  it('passes when every entity has a non-empty primary key', () => {
    expect(checkI1(wellFormedModel())).toEqual([]);
    expect(isOk(validateInvariant(wellFormedModel(), 'I1'))).toBe(true);
  });

  it('flags an entity with an empty primary key, identifying the entity', () => {
    const model = wellFormedModel();
    model.entities[0].primaryKey = [];
    const violations = checkI1(model);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({ invariant: 'I1', entity: 'User' });
  });

  it('returns an Err Result through validateInvariant on violation', () => {
    const model = wellFormedModel();
    model.entities[1].primaryKey = [];
    const result = validateInvariant(model, 'I1');
    expect(isErr(result)).toBe(true);
    if (isErr(result)) {
      expect(result.error[0].invariant).toBe('I1');
    }
  });
});

// ---------------------------------------------------------------------------
// I2 — every attribute has a supported data type (Req 1.4)
// ---------------------------------------------------------------------------

describe('I2 — supported attribute data types', () => {
  it('passes when every attribute type is supported', () => {
    expect(checkI2(wellFormedModel())).toEqual([]);
  });

  it('passes for every member of SUPPORTED_DATA_TYPES', () => {
    const model: DataModel = {
      entities: [
        {
          name: 'E',
          attributes: SUPPORTED_DATA_TYPES.map((t) => ({
            name: `a_${t}`,
            dataType: t,
            constraints: [],
          })),
          primaryKey: [`a_${SUPPORTED_DATA_TYPES[0]}`],
          isJoinEntity: false,
        },
      ],
      relationships: [],
    };
    expect(checkI2(model)).toEqual([]);
  });

  it('flags an unsupported data type, identifying entity/attribute/type', () => {
    const model = wellFormedModel();
    model.entities[0].attributes[0].dataType = 'GEOMETRY' as DataType;
    const violations = checkI2(model);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({
      invariant: 'I2',
      entity: 'User',
      attribute: 'id',
      dataType: 'GEOMETRY',
    });
  });
});

// ---------------------------------------------------------------------------
// I3 — valid relationship cardinality (Req 1.3)
// ---------------------------------------------------------------------------

describe('I3 — valid relationship cardinality', () => {
  it('passes for the three allowed cardinalities', () => {
    const model: DataModel = {
      entities: [userEntity(), postEntity()],
      relationships: [
        { source: 'Post', target: 'User', cardinality: 'ONE_TO_ONE' },
        { source: 'Post', target: 'User', cardinality: 'ONE_TO_MANY' },
      ],
    };
    expect(checkI3(model)).toEqual([]);
  });

  it('flags an invalid cardinality, identifying the relationship', () => {
    const model = wellFormedModel();
    // Force an out-of-domain cardinality value.
    (model.relationships[0] as { cardinality: string }).cardinality =
      'MANY_TO_ONE';
    const violations = checkI3(model);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({
      invariant: 'I3',
      cardinality: 'MANY_TO_ONE',
    });
    if (violations[0].invariant === 'I3') {
      expect(violations[0].relationship).toMatchObject({
        source: 'Post',
        target: 'User',
      });
    }
  });
});

// ---------------------------------------------------------------------------
// I4 — M:N relationships have a join entity referencing both PKs (Req 1.5)
// ---------------------------------------------------------------------------

describe('I4 — many-to-many join entities', () => {
  function manyToManyModel(): DataModel {
    return {
      entities: [
        {
          name: 'Student',
          attributes: [{ name: 'id', dataType: 'UUID', constraints: [] }],
          primaryKey: ['id'],
          isJoinEntity: false,
        },
        {
          name: 'Course',
          attributes: [{ name: 'id', dataType: 'UUID', constraints: [] }],
          primaryKey: ['id'],
          isJoinEntity: false,
        },
        {
          name: 'Student_Course',
          attributes: [
            {
              name: 'Student_id',
              dataType: 'UUID',
              constraints: [
                {
                  kind: 'FOREIGN_KEY',
                  references: { entity: 'Student', attribute: 'id' },
                },
              ],
            },
            {
              name: 'Course_id',
              dataType: 'UUID',
              constraints: [
                {
                  kind: 'FOREIGN_KEY',
                  references: { entity: 'Course', attribute: 'id' },
                },
              ],
            },
          ],
          primaryKey: ['Student_id', 'Course_id'],
          isJoinEntity: true,
        },
      ],
      relationships: [
        { source: 'Student', target: 'Course', cardinality: 'MANY_TO_MANY' },
      ],
    };
  }

  it('passes when a join entity references both endpoints PKs', () => {
    expect(checkI4(manyToManyModel())).toEqual([]);
  });

  it('flags a M:N relationship missing its join entity', () => {
    const model = manyToManyModel();
    // Drop the join entity.
    model.entities = model.entities.filter((e) => !e.isJoinEntity);
    const violations = checkI4(model);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({ invariant: 'I4' });
    if (violations[0].invariant === 'I4') {
      expect(violations[0].missingReferenceTo.sort()).toEqual(
        ['Course', 'Student'].sort(),
      );
    }
  });

  it('flags when the join entity only references one endpoint', () => {
    const model = manyToManyModel();
    const join = model.entities.find((e) => e.isJoinEntity)!;
    // Remove the FK to Course, leaving only the Student reference.
    join.attributes = join.attributes.filter((a) => a.name !== 'Course_id');
    join.primaryKey = ['Student_id'];
    expect(checkI4(model)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// I5 — foreign-key targets exist (Req 2.5, 2.6)
// ---------------------------------------------------------------------------

describe('I5 — foreign-key targets exist', () => {
  it('passes when every FK references a defined entity', () => {
    expect(checkI5(wellFormedModel())).toEqual([]);
  });

  it('flags an FK referencing an undefined entity', () => {
    const model = wellFormedModel();
    const post = model.entities.find((e) => e.name === 'Post')!;
    post.attributes[1].constraints = [
      {
        kind: 'FOREIGN_KEY',
        references: { entity: 'Ghost', attribute: 'id' },
      },
    ];
    const violations = checkI5(model);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({
      invariant: 'I5',
      entity: 'Post',
      attribute: 'authorId',
      referencedEntity: 'Ghost',
    });
  });
});

// ---------------------------------------------------------------------------
// I6 — relationship referential closure (Req 3.7 precondition)
// ---------------------------------------------------------------------------

describe('I6 — relationship referential closure', () => {
  it('passes when both endpoints name defined entities', () => {
    expect(checkI6(wellFormedModel())).toEqual([]);
  });

  it('flags a relationship whose target is undefined', () => {
    const model = wellFormedModel();
    model.relationships[0] = {
      source: 'Post',
      target: 'Ghost',
      cardinality: 'ONE_TO_MANY',
    };
    const violations = checkI6(model);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({
      invariant: 'I6',
      missingEndpoint: 'target',
      entity: 'Ghost',
    });
  });

  it('flags a relationship whose source is undefined', () => {
    const model = wellFormedModel();
    model.relationships[0] = {
      source: 'Nowhere',
      target: 'User',
      cardinality: 'ONE_TO_MANY',
    };
    const violations = checkI6(model);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({
      invariant: 'I6',
      missingEndpoint: 'source',
      entity: 'Nowhere',
    });
  });
});

// ---------------------------------------------------------------------------
// validateDataModel — aggregate
// ---------------------------------------------------------------------------

describe('validateDataModel — aggregate of I1–I6', () => {
  it('returns ok(model) for a well-formed model', () => {
    const model = wellFormedModel();
    const result = validateDataModel(model);
    expect(isOk(result)).toBe(true);
    if (isOk(result)) {
      expect(result.value).toBe(model);
    }
  });

  it('aggregates violations from multiple invariants', () => {
    const model = wellFormedModel();
    model.entities[0].primaryKey = []; // I1
    model.entities[0].attributes[0].dataType = 'GEOMETRY' as DataType; // I2
    (model.relationships[0] as { cardinality: string }).cardinality =
      'BOGUS'; // I3
    const result = validateDataModel(model);
    expect(isErr(result)).toBe(true);
    if (isErr(result)) {
      const ids = new Set(result.error.map((v) => v.invariant));
      expect(ids.has('I1')).toBe(true);
      expect(ids.has('I2')).toBe(true);
      expect(ids.has('I3')).toBe(true);
    }
  });
});
