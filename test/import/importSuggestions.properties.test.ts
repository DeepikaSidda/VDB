/**
 * Property-based + edge tests for the Import_Analyzer suggestion engine
 * (task 15.3) [STRETCH].
 *
 * Feature: ai-database-architect, Property 44: Import suggestions identify each detectable issue
 *
 * **Validates: Requirements 11.3**
 *
 * Property text (design): *For any* imported Data_Model containing missing
 * primary keys, missing foreign-key relationships, or denormalized structures
 * up to third normal form, the Import_Analyzer produces a suggestion for each
 * that identifies the affected element, the issue, and a proposed change.
 *
 * Strategy: deliberately plant each detectable issue into a generated
 * Data_Model — (a) an entity with no primary key, (b) a column named like a
 * foreign key (`<base>_id`) with no FOREIGN_KEY constraint, and (c) a
 * repeating-group shape (`<base>1`, `<base>2`) — across arbitrary entity and
 * column names, then assert `suggest(model)` returns a suggestion of the right
 * kind that identifies the affected element with a non-empty issue and a
 * non-empty proposed change.
 */

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import type {
  Attribute,
  DataModel,
  Entity,
} from '../../src/model/types.js';
import {
  SourceImportAnalyzer,
  type ImprovementSuggestion,
} from '../../src/import/importAnalyzer.js';
import { InMemorySource } from '../../src/import/inMemorySource.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** A fresh analyzer; the driver is unused by `suggest` but required to construct. */
function analyzer(): SourceImportAnalyzer {
  return new SourceImportAnalyzer(new InMemorySource());
}

function uuidPk(name = 'id'): Attribute {
  return { name, dataType: 'UUID', constraints: [{ kind: 'PRIMARY_KEY' }] };
}

function plainAttr(name: string): Attribute {
  return { name, dataType: 'TEXT', constraints: [] };
}

function hasSuggestionForEntity(
  suggestions: ImprovementSuggestion[],
  kind: ImprovementSuggestion['kind'],
  entity: string,
): ImprovementSuggestion | undefined {
  return suggestions.find(
    (s) =>
      s.kind === kind &&
      s.element.kind === 'ENTITY' &&
      s.element.entity === entity,
  );
}

function hasSuggestionForAttribute(
  suggestions: ImprovementSuggestion[],
  kind: ImprovementSuggestion['kind'],
  entity: string,
  attribute: string,
): ImprovementSuggestion | undefined {
  return suggestions.find(
    (s) =>
      s.kind === kind &&
      s.element.kind === 'ATTRIBUTE' &&
      s.element.entity === entity &&
      s.element.attribute === attribute,
  );
}

function expectWellFormed(suggestion: ImprovementSuggestion | undefined): void {
  expect(suggestion).toBeDefined();
  expect(typeof suggestion!.issue).toBe('string');
  expect(suggestion!.issue.length).toBeGreaterThan(0);
  expect(typeof suggestion!.proposedChange).toBe('string');
  expect(suggestion!.proposedChange.length).toBeGreaterThan(0);
}

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

/** A safe lowercase-letter identifier (no digits, no underscores). */
const identifierArb: fc.Arbitrary<string> = fc
  .array(fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz'.split('')), {
    minLength: 3,
    maxLength: 8,
  })
  .map((cs) => cs.join(''));

/** Three distinct entity names (one per planted issue) plus FK/repeat bases. */
const plantedModelArb = fc
  .record({
    names: fc.uniqueArray(identifierArb, { minLength: 3, maxLength: 3 }),
    fkBase: identifierArb,
    rgBase: identifierArb,
    extraAttrs: fc.uniqueArray(identifierArb, { minLength: 0, maxLength: 3 }),
  })
  .map(({ names, fkBase, rgBase, extraAttrs }) => {
    const [noPkName, fkName, rgName] = names;

    // (a) Entity with NO primary key -> MISSING_PRIMARY_KEY.
    const noPkEntity: Entity = {
      name: noPkName,
      attributes: extraAttrs.map(plainAttr),
      primaryKey: [],
      isJoinEntity: false,
    };

    // (b) Entity with a `<base>_id` column carrying NO foreign-key constraint
    //     -> MISSING_FOREIGN_KEY.
    const fkColumn = `${fkBase}_id`;
    const fkEntity: Entity = {
      name: fkName,
      attributes: [uuidPk(), plainAttr(fkColumn)],
      primaryKey: ['id'],
      isJoinEntity: false,
    };

    // (c) Entity with a repeating group `<base>1`, `<base>2` -> NORMALIZATION.
    const rgEntity: Entity = {
      name: rgName,
      attributes: [uuidPk(), plainAttr(`${rgBase}1`), plainAttr(`${rgBase}2`)],
      primaryKey: ['id'],
      isJoinEntity: false,
    };

    const model: DataModel = {
      entities: [noPkEntity, fkEntity, rgEntity],
      relationships: [],
    };
    return { model, noPkName, fkName, fkColumn, rgName };
  });

// ---------------------------------------------------------------------------
// Property 44
// ---------------------------------------------------------------------------

describe('Property 44: Import suggestions identify each detectable issue (Req 11.3)', () => {
  it('produces a well-formed suggestion identifying each planted issue', () => {
    fc.assert(
      fc.property(plantedModelArb, ({ model, noPkName, fkName, fkColumn, rgName }) => {
        const suggestions = analyzer().suggest(model);

        // (a) Missing primary key on the PK-less entity.
        expectWellFormed(
          hasSuggestionForEntity(suggestions, 'MISSING_PRIMARY_KEY', noPkName),
        );

        // (b) Missing foreign key on the `<base>_id` column.
        expectWellFormed(
          hasSuggestionForAttribute(
            suggestions,
            'MISSING_FOREIGN_KEY',
            fkName,
            fkColumn,
          ),
        );

        // (c) Normalization for the repeating group.
        expectWellFormed(
          hasSuggestionForEntity(suggestions, 'NORMALIZATION', rgName),
        );
      }),
      { numRuns: 200 },
    );
  });
});

// ---------------------------------------------------------------------------
// Representative edge cases (concrete shapes)
// ---------------------------------------------------------------------------

describe('Property 44 — representative edge cases', () => {
  it('flags an entity with no primary key', () => {
    const model: DataModel = {
      entities: [
        { name: 'orders', attributes: [plainAttr('total')], primaryKey: [], isJoinEntity: false },
      ],
      relationships: [],
    };
    const suggestion = hasSuggestionForEntity(
      analyzer().suggest(model),
      'MISSING_PRIMARY_KEY',
      'orders',
    );
    expectWellFormed(suggestion);
  });

  it('flags a customer_id column with no foreign-key constraint', () => {
    const model: DataModel = {
      entities: [
        {
          name: 'orders',
          attributes: [uuidPk(), plainAttr('customer_id')],
          primaryKey: ['id'],
          isJoinEntity: false,
        },
      ],
      relationships: [],
    };
    const suggestion = hasSuggestionForAttribute(
      analyzer().suggest(model),
      'MISSING_FOREIGN_KEY',
      'orders',
      'customer_id',
    );
    expectWellFormed(suggestion);
  });

  it('flags a repeating group (phone1, phone2) as a normalization issue', () => {
    const model: DataModel = {
      entities: [
        {
          name: 'contact',
          attributes: [uuidPk(), plainAttr('phone1'), plainAttr('phone2')],
          primaryKey: ['id'],
          isJoinEntity: false,
        },
      ],
      relationships: [],
    };
    const suggestion = hasSuggestionForEntity(
      analyzer().suggest(model),
      'NORMALIZATION',
      'contact',
    );
    expectWellFormed(suggestion);
  });

  it('flags a transitive-dependency group (addr_*) with a sibling addr_id', () => {
    const model: DataModel = {
      entities: [
        {
          name: 'person',
          attributes: [
            uuidPk(),
            plainAttr('addr_id'),
            plainAttr('addr_city'),
            plainAttr('addr_zip'),
          ],
          primaryKey: ['id'],
          isJoinEntity: false,
        },
      ],
      relationships: [],
    };
    const suggestion = hasSuggestionForEntity(
      analyzer().suggest(model),
      'NORMALIZATION',
      'person',
    );
    expectWellFormed(suggestion);
  });

  it('does not flag a well-formed entity', () => {
    const model: DataModel = {
      entities: [
        {
          name: 'product',
          attributes: [uuidPk(), plainAttr('title')],
          primaryKey: ['id'],
          isJoinEntity: false,
        },
      ],
      relationships: [],
    };
    expect(analyzer().suggest(model)).toEqual([]);
  });
});
