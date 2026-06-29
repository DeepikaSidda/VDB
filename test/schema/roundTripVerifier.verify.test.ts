/**
 * Unit tests for the Round-Trip Verifier deploy gate (task 4.2).
 *
 * Covers `verify`: a faithful generate -> parseDDL round-trip passes
 * (Req 12.1–12.4), and an added/lost/altered entity, relationship, or
 * constraint fails closed with a specific diff while leaving the source model
 * unchanged (Req 12.5).
 */

import { describe, it, expect } from 'vitest';
import type { DataModel } from '../../src/model/types.js';
import { isOk, isErr, unwrap } from '../../src/model/result.js';
import { generate } from '../../src/schema/schemaGenerator.js';
import {
  DefaultRoundTripVerifier,
  verify,
} from '../../src/schema/roundTripVerifier.js';

/** A small but representative two-entity model with an FK relationship. */
function sampleModel(): DataModel {
  return {
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
        ],
        primaryKey: ['id'],
        isJoinEntity: false,
      },
      {
        name: 'Post',
        attributes: [
          { name: 'id', dataType: 'UUID', constraints: [] },
          { name: 'title', dataType: 'TEXT', constraints: [] },
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
    relationships: [{ source: 'Post', target: 'User', cardinality: 'ONE_TO_MANY' }],
  };
}

describe('verify (round-trip deploy gate)', () => {
  it('accepts a faithful generate -> parseDDL round-trip', () => {
    const model = sampleModel();
    const ddl = unwrap(generate(model));
    const result = verify(ddl, model);
    expect(isOk(result)).toBe(true);
  });

  it('works through the DefaultRoundTripVerifier port', () => {
    const model = sampleModel();
    const verifier = new DefaultRoundTripVerifier();
    const ddl = unwrap(generate(model));
    expect(isOk(verifier.verify(ddl, model))).toBe(true);
  });

  it('detects a lost entity when the source has an entity absent from the DDL', () => {
    const model = sampleModel();
    const ddl = unwrap(generate(model));
    // Source claims an extra entity that the DDL never produced.
    const inflatedSource: DataModel = {
      ...model,
      entities: [
        ...model.entities,
        {
          name: 'Ghost',
          attributes: [{ name: 'id', dataType: 'UUID', constraints: [] }],
          primaryKey: ['id'],
          isJoinEntity: false,
        },
      ],
    };
    const result = verify(ddl, inflatedSource);
    expect(isErr(result)).toBe(true);
    if (isErr(result)) {
      expect(result.error.entities?.lost).toContain('Ghost');
      expect(result.error.message).toMatch(/Ghost/);
    }
  });

  it('detects an altered attribute type', () => {
    const model = sampleModel();
    const ddl = unwrap(generate(model));
    const altered: DataModel = {
      ...model,
      entities: model.entities.map((e) =>
        e.name === 'Post'
          ? {
              ...e,
              attributes: e.attributes.map((a) =>
                a.name === 'title' ? { ...a, dataType: 'INTEGER' as const } : a,
              ),
            }
          : e,
      ),
    };
    const result = verify(ddl, altered);
    expect(isErr(result)).toBe(true);
    if (isErr(result)) {
      expect(result.error.entities?.altered).toContain('Post');
    }
  });

  it('detects a lost foreign-key relationship and constraint', () => {
    const model = sampleModel();
    // Generate from a model WITHOUT the FK, then verify against a source WITH it.
    const noFk: DataModel = {
      entities: [
        model.entities[0],
        {
          ...model.entities[1],
          attributes: model.entities[1].attributes.map((a) =>
            a.name === 'authorId' ? { ...a, constraints: [] } : a,
          ),
        },
      ],
      relationships: [],
    };
    const ddl = unwrap(generate(noFk));
    const result = verify(ddl, model);
    expect(isErr(result)).toBe(true);
    if (isErr(result)) {
      expect(result.error.relationships?.lost.length).toBeGreaterThan(0);
      expect(result.error.constraints?.lost.length).toBeGreaterThan(0);
    }
  });

  it('leaves the source Data_Model unchanged on a mismatch (Req 12.5)', () => {
    const model = sampleModel();
    const snapshot = JSON.stringify(model);
    const noFk: DataModel = {
      entities: [
        model.entities[0],
        {
          ...model.entities[1],
          attributes: model.entities[1].attributes.map((a) =>
            a.name === 'authorId' ? { ...a, constraints: [] } : a,
          ),
        },
      ],
      relationships: [],
    };
    const ddl = unwrap(generate(noFk));
    verify(ddl, model);
    expect(JSON.stringify(model)).toBe(snapshot);
  });
});
