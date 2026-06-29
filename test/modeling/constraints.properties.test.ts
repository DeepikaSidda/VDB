/**
 * Property-based tests for constraint inference and enforcement.
 *
 * - Property 7 exercises `isValidEmail` (the email-format predicate backing the
 *   `FORMAT: 'EMAIL'` constraint, Req 2.3).
 * - Property 8 exercises both halves of the numeric-range rule (Req 2.4):
 *   inference (count/quantity/age/price numeric attributes get RANGE min 0,
 *   via the Modeling_Engine) and enforcement (a value below the minimum is
 *   rejected, via the generated CRUD runtime's real validator).
 *
 * Each property runs a minimum of 100 generated cases.
 */

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { isValidEmail } from '../../src/modeling/constraints.js';
import { ModelingEngine } from '../../src/modeling/modelingEngine.js';
import {
  StubLlmClient,
  type RawCandidateModel,
} from '../../src/modeling/llmClient.js';
import { buildCrudSet } from '../../src/api/crudRuntime.js';
import type { DataModel } from '../../src/model/types.js';
import { isOk, isErr, unwrap } from '../../src/model/result.js';

const NUM_RUNS = 100;

// ---------------------------------------------------------------------------
// Property 7: Email format constraint accepts exactly the well-formed emails
// ---------------------------------------------------------------------------

/**
 * The reference predicate from Requirement 2.3, kept deliberately independent
 * of the implementation: a value is well-formed iff it contains exactly one
 * "@" separating a non-empty local part from a domain part containing a ".".
 */
function referenceWellFormed(value: string): boolean {
  const parts = value.split('@');
  if (parts.length !== 2) {
    return false;
  }
  const [local, domain] = parts;
  return local.length > 0 && domain.includes('.');
}

describe('Property 7: Email format constraint accepts exactly the well-formed emails', () => {
  /** Generator biased to produce many "@" / "." structures, valid and not. */
  const emailishArb = fc.oneof(
    // Structured: local @ domain with a dot.
    fc
      .tuple(
        fc.string({ maxLength: 8 }),
        fc.string({ maxLength: 6 }),
        fc.string({ maxLength: 4 }),
      )
      .map(([l, d1, d2]) => `${l}@${d1}.${d2}`),
    // Free-form strings containing @ and . at random.
    fc.string({ maxLength: 30 }),
    // A pool of tricky literals.
    fc.constantFrom(
      'a@b.c',
      'a@b',
      '@b.c',
      'a@@b.c',
      'a@b.c@d.e',
      'plainaddress',
      'a b@c.d',
      'a@.com',
      'x@y.z',
      '',
      '@',
      '.',
      'a@b.',
    ),
  );

  // Feature: ai-database-architect, Property 7: For any string, the inferred email-format constraint accepts the string if and only if it contains exactly one `@` separating a non-empty local part from a domain part that contains at least one `.`, and rejects every other string.
  it('isValidEmail accepts iff the string is well-formed per Req 2.3', () => {
    fc.assert(
      fc.property(emailishArb, (value) => {
        expect(isValidEmail(value)).toBe(referenceWellFormed(value));
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('accepts clearly-valid and rejects clearly-invalid examples', () => {
    for (const good of ['user@example.com', 'a@b.c', 'first.last@sub.domain.io']) {
      expect(isValidEmail(good)).toBe(true);
    }
    for (const bad of [
      'no-at-sign',
      'two@@signs.com',
      'a@b@c.com',
      'missingdomaindot@com',
      '@nolocal.com',
    ]) {
      expect(isValidEmail(bad)).toBe(false);
    }
    // Note: 'trailingdot@domain.' has a "." in the domain, so per the literal
    // Req 2.3 rule it is ACCEPTED (the rule checks for the presence of a ".",
    // not that the domain is otherwise well-formed). Verify the predicate
    // matches the spec exactly rather than a stricter intuition.
    expect(isValidEmail('trailingdot@domain.')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Property 8: Numeric range constraint inference and enforcement
// ---------------------------------------------------------------------------

describe('Property 8: Numeric range constraint inference and enforcement', () => {
  const LOWER_BOUND_NAMES = ['count', 'quantity', 'age', 'price'] as const;
  const NUMERIC_TYPE_STRINGS = ['integer', 'int', 'bigint', 'numeric'] as const;

  function candidateWithNumericAttr(
    attrName: string,
    typeStr: string,
  ): RawCandidateModel {
    return {
      entities: [
        {
          name: 'Item',
          attributes: [
            { name: 'id', dataType: 'uuid' },
            { name: attrName, dataType: typeStr },
          ],
        },
      ],
      relationships: [],
    };
  }

  // Feature: ai-database-architect, Property 8: For any numeric attribute named with a natural-lower-bound concept (count, quantity, age, price), the Modeling_Engine attaches a range constraint with minimum 0; and for any value below a range constraint's minimum, the constraint rejects that value.
  it('attaches RANGE min 0 to count/quantity/age/price numeric attributes (inference)', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(...LOWER_BOUND_NAMES),
        fc.constantFrom(...NUMERIC_TYPE_STRINGS),
        async (attrName, typeStr) => {
          const engine = new ModelingEngine(
            new StubLlmClient(candidateWithNumericAttr(attrName, typeStr)),
          );
          const result = await engine.inferFromPrompt('items with quantities');
          expect(isOk(result)).toBe(true);
          const item = unwrap(result).entities.find((e) => e.name === 'Item')!;
          const attr = item.attributes.find((a) => a.name === attrName)!;
          const range = attr.constraints.find((c) => c.kind === 'RANGE');
          expect(range).toBeDefined();
          if (range && range.kind === 'RANGE') {
            expect(range.min).toBe(0);
          }
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  /**
   * Enforcement: build the real CRUD runtime for a model whose `count`
   * attribute carries a RANGE min 0, then assert that values below the minimum
   * are rejected and values at/above it are accepted.
   */
  const rangeModel: DataModel = {
    entities: [
      {
        name: 'Item',
        attributes: [
          { name: 'id', dataType: 'UUID', constraints: [] },
          {
            name: 'count',
            dataType: 'INTEGER',
            constraints: [{ kind: 'RANGE', min: 0 }],
          },
        ],
        primaryKey: ['id'],
        isJoinEntity: false,
      },
    ],
    relationships: [],
  };

  it('rejects any value below the range minimum (enforcement)', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: -1_000_000, max: -1 }),
        (belowMin) => {
          const crud = buildCrudSet(rangeModel).get('Item')!;
          const result = crud.create({ count: belowMin });
          expect(isErr(result)).toBe(true);
          if (isErr(result)) {
            expect(
              result.error.violations.some(
                (v) => v.attribute === 'count' && v.kind === 'RANGE',
              ),
            ).toBe(true);
          }
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it('accepts values at or above the range minimum (enforcement)', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 1_000_000 }), (atOrAbove) => {
        const crud = buildCrudSet(rangeModel).get('Item')!;
        const result = crud.create({ count: atOrAbove });
        expect(isOk(result)).toBe(true);
      }),
      { numRuns: NUM_RUNS },
    );
  });
});
