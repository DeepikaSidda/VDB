/**
 * Property-based + unit tests for the Refinement_Engine (tasks 9.2–9.5).
 *
 * Covers Properties 35–37 from the design plus the refinement edge-case unit
 * tests (skip path no-op, empty model → zero questions). Each property runs a
 * minimum of 100 generated cases.
 *
 *  - Property 35 (task 9.2): clarifying questions are bounded (1..10) and every
 *    question is grounded in an element present in the model. (Req 8.1)
 *  - Property 36 (task 9.3): applying valid (non-conflicting) answers retains
 *    every uncontradicted prior element and reflects each answer. (Req 8.3, 8.4)
 *  - Property 37 (task 9.4): a conflicting answer is rejected, the model is left
 *    exactly unchanged, and the conflicting element is reported. (Req 8.5)
 *  - Unit (task 9.5): skip path returns the model unchanged (Req 8.6); an empty
 *    model yields zero questions (Req 8.2).
 */

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import {
  RefinementEngine,
  deriveQuestions,
  applyAnswers,
  selectOption,
  MAX_QUESTIONS,
  type Answer,
  type ModelElementRef,
} from '../../src/refinement/refinementEngine.js';
import type {
  Attribute,
  DataModel,
  Entity,
  Relationship,
} from '../../src/model/types.js';
import { validateDataModel } from '../../src/model/invariants.js';
import { isOk, isErr, unwrap } from '../../src/model/result.js';

const NUM_RUNS = 100;

// ---------------------------------------------------------------------------
// Arbitraries — well-formed Data_Models with >= 1 entity
// ---------------------------------------------------------------------------

/** A pool of distinct entity names. */
const ENTITY_NAMES = [
  'User',
  'Post',
  'Comment',
  'Order',
  'Product',
  'Tag',
  'Category',
  'Author',
] as const;

/** Non-id attribute names that never collide with the synthesized id PK. */
const ATTR_NAMES = [
  'name',
  'title',
  'body',
  'price',
  'quantity',
  'email',
  'status',
  'count',
] as const;

const DATA_TYPES = [
  'TEXT',
  'VARCHAR',
  'INTEGER',
  'BIGINT',
  'NUMERIC',
  'BOOLEAN',
  'DATE',
  'JSON',
] as const;

/** A non-id, non-PK attribute. */
const attributeArb: fc.Arbitrary<Attribute> = fc.record({
  name: fc.constantFrom(...ATTR_NAMES),
  dataType: fc.constantFrom(...DATA_TYPES),
  constraints: fc.constant([]),
});

/**
 * An entity with a single UUID `id` primary key plus 0..4 additional unique
 * attributes. The `id` PK satisfies I1; all data types satisfy I2.
 */
function entityArb(name: string): fc.Arbitrary<Entity> {
  return fc
    .uniqueArray(attributeArb, {
      maxLength: 4,
      selector: (a) => a.name,
    })
    .map((extra) => ({
      name,
      attributes: [
        { name: 'id', dataType: 'UUID', constraints: [{ kind: 'PRIMARY_KEY' }] },
        ...extra,
      ],
      primaryKey: ['id'],
      isJoinEntity: false,
    }));
}

/**
 * A well-formed Data_Model with at least one entity. Relationships are limited
 * to ONE_TO_ONE / ONE_TO_MANY between distinct existing entities so the model
 * always satisfies the invariants (MANY_TO_MANY would require a join entity).
 */
const dataModelArb: fc.Arbitrary<DataModel> = fc
  .uniqueArray(fc.constantFrom(...ENTITY_NAMES), {
    minLength: 1,
    maxLength: ENTITY_NAMES.length,
  })
  .chain((names) =>
    fc
      .tuple(
        fc.tuple(...names.map((n) => entityArb(n))),
        // Candidate relationships between distinct entities.
        fc.array(
          fc.record({
            source: fc.constantFrom(...names),
            target: fc.constantFrom(...names),
            cardinality: fc.constantFrom(
              'ONE_TO_ONE' as const,
              'ONE_TO_MANY' as const,
            ),
          }),
          { maxLength: 4 },
        ),
      )
      .map(([entities, rawRels]) => {
        // Dedupe by endpoint pair and drop self-references.
        const seen = new Set<string>();
        const relationships: Relationship[] = [];
        for (const r of rawRels) {
          if (r.source === r.target) {
            continue;
          }
          const key = `${r.source}\u0000${r.target}`;
          if (seen.has(key)) {
            continue;
          }
          seen.add(key);
          relationships.push(r);
        }
        return { entities: [...entities], relationships };
      }),
  );

/** Resolve a ModelElementRef against a model (mirrors refExists semantics). */
function refResolves(model: DataModel, ref: ModelElementRef): boolean {
  switch (ref.kind) {
    case 'ENTITY':
      return model.entities.some((e) => e.name === ref.entity);
    case 'ATTRIBUTE': {
      const e = model.entities.find((x) => x.name === ref.entity);
      return e !== undefined && e.attributes.some((a) => a.name === ref.attribute);
    }
    case 'RELATIONSHIP':
      return model.relationships.some(
        (r) => r.source === ref.source && r.target === ref.target,
      );
  }
}

// ---------------------------------------------------------------------------
// Property 35: Clarifying questions are bounded and grounded (task 9.2)
// ---------------------------------------------------------------------------

describe('Property 35: Clarifying questions are bounded and grounded', () => {
  // Feature: ai-database-architect, Property 35: For any initial Data_Model containing at least one entity, attribute, or relationship, the Refinement_Engine presents between 1 and 10 clarifying questions, and each presented question maps to at least one entity, attribute, or relationship present in that model.
  it('presents 1..10 questions, each grounded in a present model element', () => {
    fc.assert(
      fc.property(dataModelArb, (model) => {
        const questions = deriveQuestions(model);

        // Bounded: between 1 and MAX_QUESTIONS (10) inclusive.
        expect(questions.length).toBeGreaterThanOrEqual(1);
        expect(questions.length).toBeLessThanOrEqual(MAX_QUESTIONS);

        // Grounded: every question maps to >= 1 element present in the model.
        for (const q of questions) {
          expect(q.groundedIn.length).toBeGreaterThanOrEqual(1);
          for (const ref of q.groundedIn) {
            expect(refResolves(model, ref)).toBe(true);
          }
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 36: Applying valid answers retains uncontradicted elements (task 9.3)
// ---------------------------------------------------------------------------

describe('Property 36: Applying valid answers retains uncontradicted elements and reflects answers', () => {
  /** Snapshot the set of entity / attribute / relationship keys in a model. */
  function elementKeys(model: DataModel): {
    entities: Set<string>;
    attributes: Set<string>;
    relationships: Set<string>;
  } {
    const entities = new Set<string>();
    const attributes = new Set<string>();
    const relationships = new Set<string>();
    for (const e of model.entities) {
      entities.add(e.name);
      for (const a of e.attributes) {
        attributes.add(`${e.name}\u0000${a.name}`);
      }
    }
    for (const r of model.relationships) {
      relationships.add(`${r.source}\u0000${r.target}`);
    }
    return { entities, attributes, relationships };
  }

  // Feature: ai-database-architect, Property 36: For any Data_Model and any set of non-conflicting answers (including additive feature answers), the updated model reflects each selected answer and retains every prior entity, attribute, and relationship not contradicted by the selected answers.
  it('retains all prior elements and reflects the additive feature answers', () => {
    fc.assert(
      fc.property(
        dataModelArb,
        // Choose, per question, whether to answer "yes" (additive) where offered.
        fc.array(fc.boolean(), { maxLength: 20 }),
        (model, picks) => {
          const questions = deriveQuestions(model);

          // Build non-conflicting answers: select the affirmative ADD_FEATURE
          // option (audit timestamps / soft-delete) on chosen questions. These
          // add new, non-colliding attributes (created_at, updated_at,
          // is_deleted) so they never contradict the existing model.
          const answers: Answer[] = [];
          questions.forEach((q, i) => {
            const wantYes = picks[i % picks.length] ?? true;
            const hasYes = q.options.some(
              (o) => o.id === 'yes' && o.effect.kind === 'ADD_FEATURE',
            );
            if (wantYes && hasYes) {
              const ans = selectOption(q, 'yes');
              if (ans) {
                answers.push(ans);
              }
            }
          });

          const before = elementKeys(model);
          const result = applyAnswers(model, answers);

          // Non-conflicting answers always succeed.
          expect(isOk(result)).toBe(true);
          const updated = unwrap(result);

          // Retention: every prior element is still present.
          const after = elementKeys(updated);
          for (const e of before.entities) {
            expect(after.entities.has(e)).toBe(true);
          }
          for (const a of before.attributes) {
            expect(after.attributes.has(a)).toBe(true);
          }
          for (const r of before.relationships) {
            expect(after.relationships.has(r)).toBe(true);
          }

          // Reflection: every selected ADD_FEATURE attribute is present.
          for (const ans of answers) {
            for (const opt of ans.selectedOptions) {
              if (opt.effect.kind !== 'ADD_FEATURE') {
                continue;
              }
              for (const { entity, attribute } of opt.effect.addition
                .attributes ?? []) {
                expect(after.attributes.has(`${entity}\u0000${attribute.name}`)).toBe(
                  true,
                );
              }
            }
          }

          // The refined model is still well-formed (I1–I6).
          expect(isOk(validateDataModel(updated))).toBe(true);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 37: Conflicting answers leave the model unchanged (task 9.4)
// ---------------------------------------------------------------------------

describe('Property 37: Conflicting answers leave the model unchanged', () => {
  /** A data type guaranteed to differ from the given one. */
  function differentType(from: string): Attribute['dataType'] {
    return from === 'TEXT' ? 'INTEGER' : 'TEXT';
  }

  // Feature: ai-database-architect, Property 37: For any answer that conflicts with an existing entity, attribute, or relationship, the Refinement_Engine rejects the answer, leaves the Data_Model exactly unchanged, and reports the conflicting element.
  it('rejects a conflicting attribute answer, reports the element, leaves model unchanged', () => {
    fc.assert(
      fc.property(dataModelArb, (model) => {
        // Target an existing entity + one of its existing attributes.
        const entity = model.entities[0];
        const target = entity.attributes[0]; // always present: the UUID `id`.

        // Craft an answer whose ADD_FEATURE addition re-adds that attribute name
        // with a DIFFERENT data type — a genuine attribute conflict (Req 8.5).
        const conflictingAnswer: Answer = {
          questionId: 'synthetic-conflict',
          selectedOptions: [
            {
              id: 'force',
              label: 'force conflicting type',
              effect: {
                kind: 'ADD_FEATURE',
                addition: {
                  attributes: [
                    {
                      entity: entity.name,
                      attribute: {
                        name: target.name,
                        dataType: differentType(target.dataType),
                        constraints: [],
                      },
                    },
                  ],
                },
              },
            },
          ],
        };

        const snapshotBefore = JSON.stringify(model);
        const result = applyAnswers(model, [conflictingAnswer]);
        const snapshotAfter = JSON.stringify(model);

        // Rejected with a conflict.
        expect(isErr(result)).toBe(true);
        if (isErr(result)) {
          const conflict = result.error;
          expect(conflict.reason).toBe('ATTRIBUTE_CONFLICT');
          // Reports the conflicting element precisely.
          expect(conflict.element).toEqual({
            kind: 'ATTRIBUTE',
            entity: entity.name,
            attribute: target.name,
          });
        }

        // The input model is left exactly unchanged (deep snapshot equality).
        expect(snapshotAfter).toBe(snapshotBefore);
      }),
      { numRuns: NUM_RUNS },
    );
  });
});

// ---------------------------------------------------------------------------
// Unit tests — refinement edge cases (task 9.5)
// ---------------------------------------------------------------------------

describe('Refinement edge cases (task 9.5)', () => {
  const engine = new RefinementEngine();

  it('skip path: applyAnswers(model, []) returns the model unchanged (Req 8.6)', () => {
    const model: DataModel = {
      entities: [
        {
          name: 'User',
          attributes: [
            { name: 'id', dataType: 'UUID', constraints: [{ kind: 'PRIMARY_KEY' }] },
            { name: 'email', dataType: 'TEXT', constraints: [] },
          ],
          primaryKey: ['id'],
          isJoinEntity: false,
        },
      ],
      relationships: [],
    };

    const before = JSON.stringify(model);
    const result = engine.applyAnswers(model, []);

    expect(isOk(result)).toBe(true);
    const out = unwrap(result);
    // Returns the initial model unchanged (same reference, no mutation).
    expect(out).toBe(model);
    expect(JSON.stringify(model)).toBe(before);
  });

  it('empty model yields zero clarifying questions (Req 8.2)', () => {
    const emptyModel: DataModel = { entities: [], relationships: [] };
    expect(engine.deriveQuestions(emptyModel)).toEqual([]);
    expect(deriveQuestions(emptyModel).length).toBe(0);
  });
});
