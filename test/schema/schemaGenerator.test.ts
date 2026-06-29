/**
 * Unit tests for the Schema_Generator happy path (task 3.1).
 *
 * Covers DDL generation for the Aurora PostgreSQL target: one table per entity
 * (Req 3.1), mapped column types and primary keys including composite (Req
 * 3.2), foreign-key constraints (Req 3.3), unique/not-null column constraints
 * (Req 3.4), and exactly one index per foreign-key column (Req 3.5).
 */

import { describe, it, expect } from 'vitest';
import type { DataModel, DataType } from '../../src/model/types.js';
import { isOk, isErr, unwrap } from '../../src/model/result.js';
import {
  DATA_TYPE_TO_POSTGRES,
  generate,
  mapDataType,
} from '../../src/schema/schemaGenerator.js';

describe('mapDataType', () => {
  it('maps every supported DataType to its fixed PostgreSQL type', () => {
    const expected: Record<DataType, string> = {
      UUID: 'uuid',
      TEXT: 'text',
      VARCHAR: 'varchar(255)',
      INTEGER: 'integer',
      BIGINT: 'bigint',
      NUMERIC: 'numeric',
      BOOLEAN: 'boolean',
      DATE: 'date',
      TIMESTAMP: 'timestamptz',
      JSON: 'jsonb',
    };
    for (const [type, pg] of Object.entries(expected)) {
      expect(mapDataType(type)).toBe(pg);
      expect(DATA_TYPE_TO_POSTGRES[type as DataType]).toBe(pg);
    }
  });

  it('returns undefined for an unmappable type string', () => {
    expect(mapDataType('GEOMETRY')).toBeUndefined();
  });
});

describe('generate (PostgreSQL happy path)', () => {
  it('defaults to the POSTGRES target', () => {
    const model: DataModel = {
      entities: [
        {
          name: 'User',
          attributes: [{ name: 'id', dataType: 'UUID', constraints: [] }],
          primaryKey: ['id'],
          isJoinEntity: false,
        },
      ],
      relationships: [],
    };
    const result = generate(model);
    expect(isOk(result)).toBe(true);
    expect(unwrap(result).target).toBe('POSTGRES');
  });

  it('produces exactly one CREATE TABLE per entity (Req 3.1)', () => {
    const model: DataModel = {
      entities: [
        {
          name: 'User',
          attributes: [{ name: 'id', dataType: 'UUID', constraints: [] }],
          primaryKey: ['id'],
          isJoinEntity: false,
        },
        {
          name: 'Post',
          attributes: [{ name: 'id', dataType: 'UUID', constraints: [] }],
          primaryKey: ['id'],
          isJoinEntity: false,
        },
      ],
      relationships: [],
    };
    const script = unwrap(generate(model));
    const creates = script.statements.filter((s) => s.kind === 'CREATE_TABLE');
    expect(creates).toHaveLength(2);
    expect(creates[0].sql).toContain('CREATE TABLE "User"');
    expect(creates[1].sql).toContain('CREATE TABLE "Post"');
  });

  it('emits mapped column types and inline unique/not-null constraints (Req 3.2, 3.4)', () => {
    const model: DataModel = {
      entities: [
        {
          name: 'User',
          attributes: [
            { name: 'id', dataType: 'UUID', constraints: [] },
            {
              name: 'email',
              dataType: 'VARCHAR',
              constraints: [{ kind: 'NOT_NULL' }, { kind: 'UNIQUE' }],
            },
            { name: 'age', dataType: 'INTEGER', constraints: [] },
          ],
          primaryKey: ['id'],
          isJoinEntity: false,
        },
      ],
      relationships: [],
    };
    const create = unwrap(generate(model)).statements.find(
      (s) => s.kind === 'CREATE_TABLE',
    )!;
    expect(create.sql).toContain('"id" uuid');
    expect(create.sql).toContain('"email" varchar(255) NOT NULL UNIQUE');
    expect(create.sql).toContain('"age" integer');
    expect(create.sql).toContain('PRIMARY KEY ("id")');
  });

  it('emits a composite primary key as a single constraint (Req 3.2)', () => {
    const model: DataModel = {
      entities: [
        {
          name: 'Enrollment',
          attributes: [
            { name: 'studentId', dataType: 'UUID', constraints: [] },
            { name: 'courseId', dataType: 'UUID', constraints: [] },
          ],
          primaryKey: ['studentId', 'courseId'],
          isJoinEntity: true,
        },
      ],
      relationships: [],
    };
    const create = unwrap(generate(model)).statements.find(
      (s) => s.kind === 'CREATE_TABLE',
    )!;
    expect(create.sql).toContain('PRIMARY KEY ("studentId", "courseId")');
    // Exactly one PRIMARY KEY constraint for the composite key.
    expect(create.sql.match(/PRIMARY KEY/g)).toHaveLength(1);
  });

  it('emits a foreign-key constraint and exactly one index per FK column (Req 3.3, 3.5)', () => {
    const model: DataModel = {
      entities: [
        {
          name: 'User',
          attributes: [{ name: 'id', dataType: 'UUID', constraints: [] }],
          primaryKey: ['id'],
          isJoinEntity: false,
        },
        {
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
        },
      ],
      relationships: [
        { source: 'Post', target: 'User', cardinality: 'ONE_TO_MANY' },
      ],
    };
    const script = unwrap(generate(model));

    const fks = script.statements.filter((s) => s.kind === 'ADD_FK');
    expect(fks).toHaveLength(1);
    expect(fks[0].sql).toContain('ALTER TABLE "Post"');
    expect(fks[0].sql).toContain('FOREIGN KEY ("authorId")');
    expect(fks[0].sql).toContain('REFERENCES "User" ("id")');

    const indexes = script.statements.filter((s) => s.kind === 'CREATE_INDEX');
    expect(indexes).toHaveLength(1);
    expect(indexes[0].sql).toContain('ON "Post" ("authorId")');
  });

  it('emits one index per foreign-key column when an entity has several FKs (Req 3.5)', () => {
    const model: DataModel = {
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
          name: 'Enrollment',
          attributes: [
            {
              name: 'studentId',
              dataType: 'UUID',
              constraints: [
                {
                  kind: 'FOREIGN_KEY',
                  references: { entity: 'Student', attribute: 'id' },
                },
              ],
            },
            {
              name: 'courseId',
              dataType: 'UUID',
              constraints: [
                {
                  kind: 'FOREIGN_KEY',
                  references: { entity: 'Course', attribute: 'id' },
                },
              ],
            },
          ],
          primaryKey: ['studentId', 'courseId'],
          isJoinEntity: true,
        },
      ],
      relationships: [],
    };
    const script = unwrap(generate(model));
    expect(script.statements.filter((s) => s.kind === 'ADD_FK')).toHaveLength(
      2,
    );
    expect(
      script.statements.filter((s) => s.kind === 'CREATE_INDEX'),
    ).toHaveLength(2);
  });
});

/**
 * Helper: index (position) of an entity's CREATE TABLE statement in the script.
 */
function createTableIndex(
  statements: { sql: string; kind: string }[],
  entityName: string,
): number {
  return statements.findIndex(
    (s) => s.kind === 'CREATE_TABLE' && s.sql.includes(`CREATE TABLE "${entityName}"`),
  );
}

describe('generate (task 3.2 — topological ordering, Req 3.6)', () => {
  it('orders CREATE TABLE so a referenced table precedes its referencing table', () => {
    // Post references User via FK, but User is declared AFTER Post in the model.
    const model: DataModel = {
      entities: [
        {
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
        },
        {
          name: 'User',
          attributes: [{ name: 'id', dataType: 'UUID', constraints: [] }],
          primaryKey: ['id'],
          isJoinEntity: false,
        },
      ],
      relationships: [
        { source: 'Post', target: 'User', cardinality: 'ONE_TO_MANY' },
      ],
    };
    const script = unwrap(generate(model));
    const userIdx = createTableIndex(script.statements, 'User');
    const postIdx = createTableIndex(script.statements, 'Post');
    expect(userIdx).toBeGreaterThanOrEqual(0);
    expect(postIdx).toBeGreaterThanOrEqual(0);
    expect(userIdx).toBeLessThan(postIdx);
  });

  it('orders a multi-level chain so every referenced table precedes its referencer', () => {
    // Comment -> Post -> User. Declared in reverse dependency order.
    const model: DataModel = {
      entities: [
        {
          name: 'Comment',
          attributes: [
            { name: 'id', dataType: 'UUID', constraints: [] },
            {
              name: 'postId',
              dataType: 'UUID',
              constraints: [
                {
                  kind: 'FOREIGN_KEY',
                  references: { entity: 'Post', attribute: 'id' },
                },
              ],
            },
          ],
          primaryKey: ['id'],
          isJoinEntity: false,
        },
        {
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
        },
        {
          name: 'User',
          attributes: [{ name: 'id', dataType: 'UUID', constraints: [] }],
          primaryKey: ['id'],
          isJoinEntity: false,
        },
      ],
      relationships: [],
    };
    const script = unwrap(generate(model));
    const userIdx = createTableIndex(script.statements, 'User');
    const postIdx = createTableIndex(script.statements, 'Post');
    const commentIdx = createTableIndex(script.statements, 'Comment');
    expect(userIdx).toBeLessThan(postIdx);
    expect(postIdx).toBeLessThan(commentIdx);
  });

  it('allows a self-referencing FK without treating the self-loop as a cycle', () => {
    const model: DataModel = {
      entities: [
        {
          name: 'Employee',
          attributes: [
            { name: 'id', dataType: 'UUID', constraints: [] },
            {
              name: 'managerId',
              dataType: 'UUID',
              constraints: [
                {
                  kind: 'FOREIGN_KEY',
                  references: { entity: 'Employee', attribute: 'id' },
                },
              ],
            },
          ],
          primaryKey: ['id'],
          isJoinEntity: false,
        },
      ],
      relationships: [],
    };
    const result = generate(model);
    expect(isOk(result)).toBe(true);
    const script = unwrap(result);
    expect(createTableIndex(script.statements, 'Employee')).toBe(0);
    expect(script.statements.filter((s) => s.kind === 'ADD_FK')).toHaveLength(1);
  });
});

describe('generate (task 3.2 — error handling, fail closed, Req 3.7-3.10)', () => {
  it('rejects a relationship referencing an undefined entity (Req 3.7) and emits no DDL', () => {
    const model: DataModel = {
      entities: [
        {
          name: 'Post',
          attributes: [{ name: 'id', dataType: 'UUID', constraints: [] }],
          primaryKey: ['id'],
          isJoinEntity: false,
        },
      ],
      relationships: [
        { source: 'Post', target: 'Ghost', cardinality: 'ONE_TO_MANY' },
      ],
    };
    const result = generate(model);
    expect(isErr(result)).toBe(true);
    if (isErr(result)) {
      expect(result.error.kind).toBe('UNDEFINED_ENTITY');
      if (result.error.kind === 'UNDEFINED_ENTITY') {
        expect(result.error.entity).toBe('Ghost');
      }
    }
  });

  it('rejects an FK referencing an undefined entity (Req 3.7) and emits no DDL', () => {
    const model: DataModel = {
      entities: [
        {
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
        },
      ],
      relationships: [],
    };
    const result = generate(model);
    expect(isErr(result)).toBe(true);
    if (isErr(result) && result.error.kind === 'UNDEFINED_ENTITY') {
      expect(result.error.entity).toBe('User');
      expect(result.error.relationship).toEqual({
        source: 'Post',
        target: 'User',
      });
    }
  });

  it('rejects an unmappable data type (Req 3.8) identifying the column and type', () => {
    const model: DataModel = {
      entities: [
        {
          name: 'Place',
          attributes: [
            { name: 'id', dataType: 'UUID', constraints: [] },
            // Intentionally invalid type to exercise the Req 3.8 path.
            { name: 'location', dataType: 'GEOMETRY' as DataType, constraints: [] },
          ],
          primaryKey: ['id'],
          isJoinEntity: false,
        },
      ],
      relationships: [],
    };
    const result = generate(model);
    expect(isErr(result)).toBe(true);
    if (isErr(result) && result.error.kind === 'UNMAPPABLE_TYPE') {
      expect(result.error.entity).toBe('Place');
      expect(result.error.attribute).toBe('location');
      expect(result.error.dataType).toBe('GEOMETRY');
    }
  });

  it('rejects an unorderable cyclic dependency (Req 3.9) identifying the cycle entities', () => {
    // A -> B -> A (mutual non-self FK references): no valid CREATE ordering.
    const model: DataModel = {
      entities: [
        {
          name: 'A',
          attributes: [
            { name: 'id', dataType: 'UUID', constraints: [] },
            {
              name: 'bId',
              dataType: 'UUID',
              constraints: [
                {
                  kind: 'FOREIGN_KEY',
                  references: { entity: 'B', attribute: 'id' },
                },
              ],
            },
          ],
          primaryKey: ['id'],
          isJoinEntity: false,
        },
        {
          name: 'B',
          attributes: [
            { name: 'id', dataType: 'UUID', constraints: [] },
            {
              name: 'aId',
              dataType: 'UUID',
              constraints: [
                {
                  kind: 'FOREIGN_KEY',
                  references: { entity: 'A', attribute: 'id' },
                },
              ],
            },
          ],
          primaryKey: ['id'],
          isJoinEntity: false,
        },
      ],
      relationships: [],
    };
    const result = generate(model);
    expect(isErr(result)).toBe(true);
    if (isErr(result) && result.error.kind === 'CYCLIC_DEPENDENCY') {
      expect(result.error.entities.sort()).toEqual(['A', 'B']);
    }
  });

  it('fails closed: an erroring model yields an Err with no MigrationScript (Req 3.10)', () => {
    const model: DataModel = {
      entities: [
        {
          name: 'Post',
          attributes: [{ name: 'id', dataType: 'UUID', constraints: [] }],
          primaryKey: ['id'],
          isJoinEntity: false,
        },
      ],
      relationships: [
        { source: 'Post', target: 'Ghost', cardinality: 'ONE_TO_MANY' },
      ],
    };
    const result = generate(model);
    expect(isOk(result)).toBe(false);
    // No statements/value are accessible on an Err — the script never exists.
    expect('value' in result).toBe(false);
  });
});
