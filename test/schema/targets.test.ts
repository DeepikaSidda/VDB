/**
 * Unit tests for the alternative target projections (task 15.2).
 *
 * Covers the Aurora DSQL relational projection (Req 13.1), the DynamoDB
 * table-design projection and its unrepresented-element report (Req 13.2,
 * 13.3), target routing through `generate`, and the unsupported-target
 * validation path (Req 13.4).
 */

import { describe, it, expect } from 'vitest';
import type { DataModel, DeploymentTargetKind } from '../../src/model/types.js';
import { isOk, isErr, unwrap } from '../../src/model/result.js';
import {
  generate,
  generateDynamoDbDesign,
  SUPPORTED_TARGETS,
} from '../../src/schema/schemaGenerator.js';

/** A small relational model: User <- Post (FK authorId), plus constraints. */
function blogModel(): DataModel {
  return {
    entities: [
      {
        name: 'User',
        attributes: [
          { name: 'id', dataType: 'UUID', constraints: [{ kind: 'PRIMARY_KEY' }] },
          {
            name: 'email',
            dataType: 'VARCHAR',
            constraints: [{ kind: 'NOT_NULL' }, { kind: 'UNIQUE' }, { kind: 'FORMAT', format: 'EMAIL' }],
          },
        ],
        primaryKey: ['id'],
        isJoinEntity: false,
      },
      {
        name: 'Post',
        attributes: [
          { name: 'id', dataType: 'UUID', constraints: [{ kind: 'PRIMARY_KEY' }] },
          { name: 'views', dataType: 'INTEGER', constraints: [{ kind: 'RANGE', min: 0 }] },
          {
            name: 'authorId',
            dataType: 'UUID',
            constraints: [
              { kind: 'FOREIGN_KEY', references: { entity: 'User', attribute: 'id' } },
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
}

describe('Aurora DSQL projection (Req 13.1)', () => {
  it('generates one CREATE TABLE per entity with PK, columns and mapped types', () => {
    const script = unwrap(generate(blogModel(), 'AURORA_DSQL'));
    expect(script.target).toBe('AURORA_DSQL');

    const creates = script.statements.filter((s) => s.kind === 'CREATE_TABLE');
    expect(creates).toHaveLength(2);

    const userCreate = creates.find((s) => s.sql.includes('CREATE TABLE "User"'))!;
    expect(userCreate.sql).toContain('"id" uuid');
    expect(userCreate.sql).toContain('"email" varchar(255)');
    expect(userCreate.sql).toContain('PRIMARY KEY ("id")');
  });

  it('applies the same fail-closed validation as PostgreSQL (undefined entity, Req 3.7/3.10)', () => {
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
    const result = generate(model, 'AURORA_DSQL');
    expect(isErr(result)).toBe(true);
    if (isErr(result)) {
      expect(result.error.kind).toBe('UNDEFINED_ENTITY');
    }
    expect('value' in result).toBe(false);
  });

  it('rejects an unmappable data type (Req 3.8)', () => {
    const model: DataModel = {
      entities: [
        {
          name: 'Place',
          attributes: [
            { name: 'id', dataType: 'UUID', constraints: [] },
            { name: 'geo', dataType: 'GEOMETRY' as never, constraints: [] },
          ],
          primaryKey: ['id'],
          isJoinEntity: false,
        },
      ],
      relationships: [],
    };
    const result = generate(model, 'AURORA_DSQL');
    expect(isErr(result)).toBe(true);
    if (isErr(result)) {
      expect(result.error.kind).toBe('UNMAPPABLE_TYPE');
    }
  });
});

describe('DynamoDB projection (Req 13.2)', () => {
  it('generates one table definition per entity, each with a designated primary key', () => {
    const script = unwrap(generate(blogModel(), 'DYNAMODB'));
    expect(script.target).toBe('DYNAMODB');

    const tables = script.statements.filter((s) => s.kind === 'CREATE_TABLE');
    expect(tables).toHaveLength(2);

    for (const t of tables) {
      const def = JSON.parse(t.sql);
      expect(def.TableName).toBeTruthy();
      expect(def.KeySchema.length).toBeGreaterThanOrEqual(1);
      // A partition (HASH) key is always designated.
      expect(def.KeySchema[0].KeyType).toBe('HASH');
    }
  });

  it('maps a composite primary key to a partition + sort key', () => {
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
    const script = unwrap(generate(model, 'DYNAMODB'));
    const def = JSON.parse(script.statements[0].sql);
    expect(def.KeySchema).toEqual([
      { AttributeName: 'studentId', KeyType: 'HASH' },
      { AttributeName: 'courseId', KeyType: 'RANGE' },
    ]);
  });
});

describe('DynamoDB unrepresented-element report (Req 13.3)', () => {
  it('reports every constraint and relationship the table design cannot represent', () => {
    const result = generateDynamoDbDesign(blogModel());
    expect(isOk(result)).toBe(true);
    const { unrepresented } = unwrap(result);

    const kinds = unrepresented.map((u) => u.kind);
    expect(kinds).toContain('FOREIGN_KEY'); // Post.authorId -> User.id
    expect(kinds).toContain('UNIQUE'); // User.email
    expect(kinds).toContain('NOT_NULL'); // User.email
    expect(kinds).toContain('FORMAT'); // User.email EMAIL
    expect(kinds).toContain('RANGE'); // Post.views >= 0
    expect(kinds).toContain('RELATIONSHIP'); // Post -> User
    // The primary keys ARE represented, so PRIMARY_KEY is never reported.
    expect(kinds).not.toContain('PRIMARY_KEY');
  });

  it('reports composite-key overflow when a primary key has more than two columns', () => {
    const model: DataModel = {
      entities: [
        {
          name: 'Triple',
          attributes: [
            { name: 'a', dataType: 'UUID', constraints: [] },
            { name: 'b', dataType: 'UUID', constraints: [] },
            { name: 'c', dataType: 'UUID', constraints: [] },
          ],
          primaryKey: ['a', 'b', 'c'],
          isJoinEntity: false,
        },
      ],
      relationships: [],
    };
    const { unrepresented } = unwrap(generateDynamoDbDesign(model));
    const overflow = unrepresented.find((u) => u.kind === 'COMPOSITE_KEY_OVERFLOW');
    expect(overflow).toBeDefined();
    if (overflow && overflow.kind === 'COMPOSITE_KEY_OVERFLOW') {
      expect(overflow.columns).toEqual(['c']);
    }
  });

  it('reports no unrepresented elements for a key-only model', () => {
    const model: DataModel = {
      entities: [
        {
          name: 'Thing',
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

describe('target routing and unsupported targets (Req 13.4)', () => {
  it('routes POSTGRES to the relational projection (default target unchanged)', () => {
    expect(unwrap(generate(blogModel())).target).toBe('POSTGRES');
    expect(unwrap(generate(blogModel(), 'POSTGRES')).target).toBe('POSTGRES');
  });

  it('returns an UNSUPPORTED_TARGET error listing supported targets and emits no output', () => {
    const result = generate(blogModel(), 'MONGODB' as DeploymentTargetKind);
    expect(isErr(result)).toBe(true);
    if (isErr(result) && result.error.kind === 'UNSUPPORTED_TARGET') {
      expect(result.error.target).toBe('MONGODB');
      expect(result.error.supportedTargets).toEqual([...SUPPORTED_TARGETS]);
      expect(result.error.message).toContain('POSTGRES');
      expect(result.error.message).toContain('AURORA_DSQL');
      expect(result.error.message).toContain('DYNAMODB');
    } else {
      throw new Error('expected UNSUPPORTED_TARGET error');
    }
    // Fail closed: no migration script exists on the Err.
    expect('value' in result).toBe(false);
  });
});
