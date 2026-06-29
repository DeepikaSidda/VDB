/**
 * Property-based tests for the Modeling_Engine's deterministic post-processing
 * (Properties 1–6) plus modeling edge-case unit tests (task 2.12).
 *
 * The LLM is stubbed with `StubLlmClient((prompt) => candidate)` so the
 * deterministic normalization + constraint-inference pipeline is exercised
 * across many generated loose `RawCandidateModel`s. Each property runs a
 * minimum of 100 generated cases.
 */

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import {
  ModelingEngine,
  MAX_PROMPT_LENGTH,
} from '../../src/modeling/modelingEngine.js';
import {
  StubLlmClient,
  type RawCandidateModel,
} from '../../src/modeling/llmClient.js';
import { SUPPORTED_DATA_TYPES } from '../../src/model/invariants.js';
import { isOk, isErr, unwrap } from '../../src/model/result.js';

const NUM_RUNS = 100;

// ---------------------------------------------------------------------------
// Arbitraries
// ---------------------------------------------------------------------------

/** Non-empty, within-length domain prompts. */
const promptArb = fc
  .string({ minLength: 1, maxLength: 200 })
  .filter((s) => s.trim().length > 0);

/** A pool of names used to encourage relationship endpoints to resolve. */
const nameArb = fc.constantFrom(
  'User',
  'Post',
  'Comment',
  'Order',
  'Product',
  'Tag',
  'Category',
  'Author',
);

/** Free-form data type strings: a mix of known aliases and junk. */
const dataTypeStringArb = fc.oneof(
  fc.constantFrom(
    'uuid',
    'text',
    'string',
    'int',
    'integer',
    'bigint',
    'numeric',
    'bool',
    'date',
    'timestamp',
    'json',
    'email',
  ),
  fc.constantFrom('weird-type', 'GEOMETRY', '', 'banana', '???'),
  fc.string({ maxLength: 8 }),
);

/** Free-form cardinality labels including many-to-many variants. */
const cardinalityStringArb = fc.oneof(
  fc.constantFrom(
    'one-to-one',
    'one-to-many',
    'many-to-many',
    'm2m',
    'MANY_TO_MANY',
    'manyToMany',
    'hasMany',
    'belongsTo',
  ),
  fc.constantFrom('', 'unknown', 'foo'),
  fc.string({ maxLength: 8 }),
);

const rawAttributeArb = fc.record(
  {
    name: fc.oneof(
      fc.string({ maxLength: 10 }),
      fc.constantFrom('email', 'count', 'quantity', 'age', 'price', 'name'),
    ),
    dataType: fc.option(dataTypeStringArb, { nil: undefined }),
    unique: fc.option(fc.boolean(), { nil: undefined }),
    required: fc.option(fc.boolean(), { nil: undefined }),
  },
  { requiredKeys: ['name'] },
);

const rawEntityArb = fc.record(
  {
    name: fc.oneof(nameArb, fc.string({ maxLength: 10 })),
    attributes: fc.array(rawAttributeArb, { maxLength: 5 }),
    primaryKey: fc.option(
      fc.array(fc.string({ maxLength: 10 }), { maxLength: 3 }),
      { nil: undefined },
    ),
  },
  { requiredKeys: ['name'] },
);

const rawRelationshipArb = fc.record(
  {
    source: nameArb,
    target: nameArb,
    cardinality: fc.option(cardinalityStringArb, { nil: undefined }),
  },
  { requiredKeys: ['source', 'target'] },
);

/** A loose raw candidate model with varied/missing/multiple fields. */
const nonEmptyRawCandidateArb: fc.Arbitrary<RawCandidateModel> = fc
  .tuple(
    fc.record(
      {
        name: nameArb,
        attributes: fc.array(rawAttributeArb, { maxLength: 5 }),
        primaryKey: fc.option(
          fc.array(fc.string({ maxLength: 10 }), { maxLength: 3 }),
          { nil: undefined },
        ),
      },
      { requiredKeys: ['name'] },
    ),
    fc.array(rawEntityArb, { maxLength: 4 }),
    fc.array(rawRelationshipArb, { maxLength: 5 }),
  )
  .map(([guaranteed, more, relationships]) => ({
    entities: [guaranteed, ...more],
    relationships,
  }));

function engineFor(
  candidate: RawCandidateModel | ((prompt: string) => RawCandidateModel),
): ModelingEngine {
  return new ModelingEngine(new StubLlmClient(candidate));
}

// ---------------------------------------------------------------------------
// Property 1: Modeling produces well-formed structure
// ---------------------------------------------------------------------------

describe('Property 1: Modeling produces well-formed structure', () => {
  // Feature: ai-database-architect, Property 1: For any non-empty, within-length domain prompt (with the LLM inference layer stubbed to return arbitrary raw candidate models), the Data_Model produced by the Modeling_Engine contains at least one entity, and every entity has at least one attribute and recorded relationships are present in the model.
  it('produces >=1 entity, each with >=1 attribute, for non-empty prompts', async () => {
    await fc.assert(
      fc.asyncProperty(
        promptArb,
        nonEmptyRawCandidateArb,
        async (prompt, candidate) => {
          const engine = engineFor(() => candidate);
          const result = await engine.inferFromPrompt(prompt);
          expect(isOk(result)).toBe(true);
          const model = unwrap(result);
          expect(model.entities.length).toBeGreaterThanOrEqual(1);
          for (const entity of model.entities) {
            expect(entity.attributes.length).toBeGreaterThanOrEqual(1);
          }
          // Recorded relationships are present in the model structure.
          expect(Array.isArray(model.relationships)).toBe(true);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 2: Exactly one primary key per entity
// ---------------------------------------------------------------------------

describe('Property 2: Exactly one primary key per entity', () => {
  // Feature: ai-database-architect, Property 2: For any Data_Model produced by the Modeling_Engine (including raw candidates with missing or multiple primary keys), every entity has exactly one primary key (a single `primaryKey` list that is non-empty), with a surrogate key synthesized when none was inferred and any FK-target entity guaranteed to have one.
  it('every entity has a single non-empty primary key', async () => {
    await fc.assert(
      fc.asyncProperty(
        promptArb,
        nonEmptyRawCandidateArb,
        async (prompt, candidate) => {
          const engine = engineFor(() => candidate);
          const result = await engine.inferFromPrompt(prompt);
          expect(isOk(result)).toBe(true);
          const model = unwrap(result);
          const names = new Set(model.entities.map((e) => e.name));
          for (const entity of model.entities) {
            expect(Array.isArray(entity.primaryKey)).toBe(true);
            expect(entity.primaryKey.length).toBeGreaterThanOrEqual(1);
            // Each PK column names a real attribute of the entity.
            const attrNames = new Set(entity.attributes.map((a) => a.name));
            for (const pk of entity.primaryKey) {
              expect(attrNames.has(pk)).toBe(true);
            }
          }
          // Any FK-target entity exists and has a primary key.
          for (const entity of model.entities) {
            for (const attr of entity.attributes) {
              for (const c of attr.constraints) {
                if (c.kind === 'FOREIGN_KEY') {
                  expect(names.has(c.references.entity)).toBe(true);
                  const target = model.entities.find(
                    (e) => e.name === c.references.entity,
                  )!;
                  expect(target.primaryKey.length).toBeGreaterThanOrEqual(1);
                }
              }
            }
          }
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 3: Relationship cardinality is always valid
// ---------------------------------------------------------------------------

describe('Property 3: Relationship cardinality is always valid', () => {
  const ALLOWED = new Set(['ONE_TO_ONE', 'ONE_TO_MANY', 'MANY_TO_MANY']);
  // Feature: ai-database-architect, Property 3: For any Data_Model produced by the Modeling_Engine, every relationship's cardinality is exactly one of `ONE_TO_ONE`, `ONE_TO_MANY`, or `MANY_TO_MANY`.
  it('every relationship cardinality is one of the three allowed values', async () => {
    await fc.assert(
      fc.asyncProperty(
        promptArb,
        nonEmptyRawCandidateArb,
        async (prompt, candidate) => {
          const engine = engineFor(() => candidate);
          const result = await engine.inferFromPrompt(prompt);
          expect(isOk(result)).toBe(true);
          for (const rel of unwrap(result).relationships) {
            expect(ALLOWED.has(rel.cardinality)).toBe(true);
          }
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 4: Every attribute has exactly one supported data type
// ---------------------------------------------------------------------------

describe('Property 4: Every attribute has exactly one supported data type', () => {
  const SUPPORTED = new Set<string>(SUPPORTED_DATA_TYPES);
  // Feature: ai-database-architect, Property 4: For any Data_Model produced by the Modeling_Engine, every attribute is assigned exactly one data type drawn from the supported `DataType` set.
  it('every attribute dataType is a member of the supported set', async () => {
    await fc.assert(
      fc.asyncProperty(
        promptArb,
        nonEmptyRawCandidateArb,
        async (prompt, candidate) => {
          const engine = engineFor(() => candidate);
          const result = await engine.inferFromPrompt(prompt);
          expect(isOk(result)).toBe(true);
          for (const entity of unwrap(result).entities) {
            for (const attr of entity.attributes) {
              expect(SUPPORTED.has(attr.dataType)).toBe(true);
            }
          }
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 5: Many-to-many relationships materialize a join entity
// ---------------------------------------------------------------------------

describe('Property 5: Many-to-many relationships materialize a join entity', () => {
  /**
   * A candidate biased toward producing many-to-many relationships between two
   * concrete entities so the join-entity materialization path is exercised.
   */
  const manyToManyCandidateArb: fc.Arbitrary<RawCandidateModel> = fc
    .tuple(
      fc.uniqueArray(nameArb, { minLength: 2, maxLength: 2 }),
      fc.array(rawAttributeArb, { maxLength: 3 }),
      fc.array(rawAttributeArb, { maxLength: 3 }),
    )
    .map(([[a, b], attrsA, attrsB]) => ({
      entities: [
        { name: a, attributes: attrsA },
        { name: b, attributes: attrsB },
      ],
      relationships: [{ source: a, target: b, cardinality: 'many-to-many' }],
    }));

  // Feature: ai-database-architect, Property 5: For any Data_Model containing a many-to-many relationship between two entities, there exists a join entity whose foreign keys reference the primary key of each of the two related entities.
  it('materializes a join entity referencing both endpoints primary keys', async () => {
    await fc.assert(
      fc.asyncProperty(
        promptArb,
        manyToManyCandidateArb,
        async (prompt, candidate) => {
          const engine = engineFor(() => candidate);
          const result = await engine.inferFromPrompt(prompt);
          expect(isOk(result)).toBe(true);
          const model = unwrap(result);
          for (const rel of model.relationships) {
            if (rel.cardinality !== 'MANY_TO_MANY') {
              continue;
            }
            const source = model.entities.find((e) => e.name === rel.source)!;
            const target = model.entities.find((e) => e.name === rel.target)!;
            const referencesPkOf = (entity: typeof source, name: string) =>
              entity.attributes.some((a) =>
                a.constraints.some(
                  (c) =>
                    c.kind === 'FOREIGN_KEY' &&
                    c.references.entity === name,
                ),
              );
            const join = model.entities.find(
              (e) =>
                e.isJoinEntity &&
                referencesPkOf(e, rel.source) &&
                referencesPkOf(e, rel.target),
            );
            expect(join).toBeDefined();
            // The join entity's FKs point at the endpoints' primary keys.
            const fkTargets = join!.attributes
              .flatMap((a) => a.constraints)
              .filter((c) => c.kind === 'FOREIGN_KEY')
              .map((c) =>
                c.kind === 'FOREIGN_KEY' ? c.references.attribute : '',
              );
            for (const pk of source.primaryKey) {
              expect(fkTargets).toContain(pk);
            }
            for (const pk of target.primaryKey) {
              expect(fkTargets).toContain(pk);
            }
          }
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 6: Empty or whitespace input is rejected
// ---------------------------------------------------------------------------

describe('Property 6: Empty or whitespace input is rejected', () => {
  /** Strings composed entirely of whitespace, including the empty string. */
  const whitespaceArb = fc
    .array(fc.constantFrom(' ', '\t', '\n', '\r', '\f', '\v'), {
      maxLength: 20,
    })
    .map((chars) => chars.join(''));

  // Feature: ai-database-architect, Property 6: For any string composed entirely of whitespace (including the empty string), submitting it as a domain description yields a validation error stating a non-empty description is required and produces no Data_Model.
  it('rejects whitespace-only and empty input with EMPTY_INPUT and no model', async () => {
    await fc.assert(
      fc.asyncProperty(whitespaceArb, async (blank) => {
        // Stub returns a perfectly good candidate; validation must reject first.
        const engine = engineFor({
          entities: [{ name: 'User', attributes: [] }],
          relationships: [],
        });
        const result = await engine.inferFromPrompt(blank);
        expect(isErr(result)).toBe(true);
        if (isErr(result)) {
          expect(result.error.kind).toBe('EMPTY_INPUT');
        }
        // No Data_Model is produced on the error path.
        expect('value' in result).toBe(false);
      }),
      { numRuns: NUM_RUNS },
    );
  });
});

// ---------------------------------------------------------------------------
// Task 2.12 — modeling edge-case unit tests (Req 1.7, 1.8, 2.7)
// ---------------------------------------------------------------------------

describe('Modeling edge cases (task 2.12)', () => {
  it('rejects a description just above 10,000 characters (Req 1.7)', async () => {
    const engine = engineFor({
      entities: [{ name: 'User', attributes: [] }],
      relationships: [],
    });
    const tooLong = 'a'.repeat(MAX_PROMPT_LENGTH + 1);
    const result = await engine.inferFromPrompt(tooLong);
    expect(isErr(result)).toBe(true);
    if (isErr(result)) {
      expect(result.error.kind).toBe('INPUT_TOO_LONG');
      if (result.error.kind === 'INPUT_TOO_LONG') {
        expect(result.error.maxLength).toBe(MAX_PROMPT_LENGTH);
        expect(result.error.actualLength).toBe(MAX_PROMPT_LENGTH + 1);
      }
    }
  });

  it('accepts a description exactly at the 10,000-character boundary (Req 1.7)', async () => {
    const engine = engineFor({
      entities: [{ name: 'User', attributes: [{ name: 'id', dataType: 'uuid' }] }],
      relationships: [],
    });
    const atLimit = 'a'.repeat(MAX_PROMPT_LENGTH);
    const result = await engine.inferFromPrompt(atLimit);
    expect(isOk(result)).toBe(true);
  });

  it('fails closed with NO_DATA_MODEL when no entity can be inferred (Req 1.8)', async () => {
    // Candidate has no usable entities (all nameless / empty).
    const engine = engineFor({ entities: [{ name: '   ' }], relationships: [] });
    const result = await engine.inferFromPrompt('describe something');
    expect(isErr(result)).toBe(true);
    if (isErr(result)) {
      expect(result.error.kind).toBe('NO_DATA_MODEL');
    }
    expect('value' in result).toBe(false);
  });

  it('flags low-confidence ambiguous attributes with needsReview (Req 2.7)', async () => {
    const engine = engineFor({
      entities: [
        {
          name: 'Widget',
          attributes: [
            { name: 'id', dataType: 'uuid' },
            // "code" is an ambiguous identifier token: not confidently unique.
            { name: 'code', dataType: 'text' },
          ],
        },
      ],
      relationships: [],
    });
    const result = await engine.inferFromPrompt('widgets have codes');
    expect(isOk(result)).toBe(true);
    const widget = unwrap(result).entities.find((e) => e.name === 'Widget')!;
    const code = widget.attributes.find((a) => a.name === 'code')!;
    expect(code.needsReview).toBe(true);
    // It was left without a UNIQUE constraint rather than guessing.
    expect(code.constraints.some((c) => c.kind === 'UNIQUE')).toBe(false);
  });
});
