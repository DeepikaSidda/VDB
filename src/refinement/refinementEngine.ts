/**
 * The Refinement_Engine (task 9.1).
 *
 * Generates clarifying questions grounded in the current Data_Model and folds
 * the builder's answers back into the model without losing prior structure.
 * Implements the Requirement 8 behavior:
 *
 *  - deriveQuestions (Req 8.1, 8.2): present between 1 and 10 clarifying
 *    questions, each grounded in (mapping to) at least one entity, attribute,
 *    or relationship in the current model. If the model has nothing from which
 *    a question can be derived, present zero questions and proceed.
 *  - applyAnswers (Req 8.3, 8.4, 8.5, 8.6): update the model to reflect each
 *    selected answer while retaining all prior elements not contradicted by the
 *    answers; add entities/attributes/relationships for opt-in feature answers;
 *    reject a conflicting answer leaving the model exactly unchanged and
 *    identifying the conflicting element; and treat the skip path (empty
 *    answers) as a no-op that returns the initial model unchanged.
 *
 * Both functions are pure: they never mutate the input model. `applyAnswers`
 * returns the model unchanged when answers are empty or when a conflict is
 * detected, and any model it returns still satisfies the Data_Model invariants
 * I1–I6 (validated by {@link validateDataModel}).
 */

import type {
  Attribute,
  DataModel,
  Entity,
  Relationship,
} from '../model/types.js';
import { type Result, err, ok, isErr } from '../model/result.js';
import {
  validateDataModel,
  type InvariantViolation,
} from '../model/invariants.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** The maximum number of clarifying questions to present (Req 8.1). */
export const MAX_QUESTIONS = 10;

// ---------------------------------------------------------------------------
// Grounding / element references (Req 8.1, Property 35)
// ---------------------------------------------------------------------------

/**
 * A reference to a single element of the Data_Model. Used both to express the
 * element(s) a clarifying question is grounded in (the "grounded" guarantee of
 * Req 8.1 / Property 35) and to identify the conflicting element when an answer
 * is rejected (Req 8.5 / Property 37).
 */
export type ModelElementRef =
  | { kind: 'ENTITY'; entity: string }
  | { kind: 'ATTRIBUTE'; entity: string; attribute: string }
  | { kind: 'RELATIONSHIP'; source: string; target: string };

// ---------------------------------------------------------------------------
// Questions, options, and answers
// ---------------------------------------------------------------------------

/**
 * Elements an opt-in feature option contributes to the model when selected
 * (Req 8.4). Any subset may be present; an option that changes nothing carries
 * a `NONE` effect instead.
 */
export type FeatureAddition = {
  entities?: Entity[];
  attributes?: { entity: string; attribute: Attribute }[];
  relationships?: Relationship[];
};

/**
 * The effect of selecting a particular option. `NONE` leaves the model
 * untouched (e.g. "keep as is"); `ADD_FEATURE` contributes the elements of an
 * opt-in feature (Req 8.4).
 */
export type AnswerEffect =
  | { kind: 'NONE' }
  | { kind: 'ADD_FEATURE'; addition: FeatureAddition };

/**
 * A single selectable option on a clarifying question. The `effect` is carried
 * on the option so that an {@link Answer} referencing it is self-contained and
 * {@link applyAnswers} can apply it without re-deriving questions.
 */
export type QuestionOption = {
  id: string;
  label: string;
  effect: AnswerEffect;
};

/**
 * A clarifying question. Every question is grounded in at least one element of
 * the current model (`groundedIn`, Req 8.1 / Property 35) and offers one or
 * more selectable options.
 */
export type ClarifyingQuestion = {
  id: string;
  prompt: string;
  /** The model element(s) this question maps to. Always non-empty. */
  groundedIn: ModelElementRef[];
  options: QuestionOption[];
};

/**
 * A builder's answer to a clarifying question. Carries the selected option(s)
 * — including their effects — so that applying answers is self-contained.
 */
export type Answer = {
  questionId: string;
  selectedOptions: QuestionOption[];
};

// ---------------------------------------------------------------------------
// Conflict reporting (Req 8.5, Property 37)
// ---------------------------------------------------------------------------

/**
 * The result of rejecting a conflicting answer. Identifies the conflicting
 * element so the UI can point the builder at it (Req 8.5). When an answer is
 * rejected, the model is left exactly unchanged (Property 37).
 */
export type RefinementConflict = {
  reason:
    | 'ENTITY_CONFLICT'
    | 'ATTRIBUTE_CONFLICT'
    | 'RELATIONSHIP_CONFLICT'
    | 'MISSING_TARGET'
    | 'INVARIANT_VIOLATION';
  message: string;
  /** The element in the existing model that the answer contradicts. */
  element: ModelElementRef;
  /** The question whose answer produced the conflict, when known. */
  questionId?: string;
  /** The selected option that produced the conflict, when known. */
  optionId?: string;
};

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/** Deep clone a Data_Model. The IR is plain JSON data, so this is safe. */
function cloneModel(model: DataModel): DataModel {
  return JSON.parse(JSON.stringify(model)) as DataModel;
}

/** Does the model contain an entity with this name? */
function hasEntity(model: DataModel, name: string): boolean {
  return model.entities.some((e) => e.name === name);
}

/**
 * Structural equality for entities, used to decide whether re-adding an
 * entity that already exists is a harmless retain (identical) or a contradiction
 * (same name, different shape). Compares the primary key, the join-entity flag,
 * and the attribute name → data type map, order-independently.
 */
function entityStructurallyEqual(a: Entity, b: Entity): boolean {
  if (a.isJoinEntity !== b.isJoinEntity) {
    return false;
  }
  const pkA = [...a.primaryKey].sort().join('\u0000');
  const pkB = [...b.primaryKey].sort().join('\u0000');
  if (pkA !== pkB) {
    return false;
  }
  if (a.attributes.length !== b.attributes.length) {
    return false;
  }
  const typesA = new Map(a.attributes.map((at) => [at.name, at.dataType]));
  for (const at of b.attributes) {
    if (typesA.get(at.name) !== at.dataType) {
      return false;
    }
  }
  return true;
}

/**
 * Check whether a grounding reference still resolves to an element present in
 * the model. Used defensively so {@link deriveQuestions} can never emit a
 * question grounded in a non-existent element (Property 35).
 */
function refExists(model: DataModel, ref: ModelElementRef): boolean {
  switch (ref.kind) {
    case 'ENTITY':
      return hasEntity(model, ref.entity);
    case 'ATTRIBUTE': {
      const entity = model.entities.find((e) => e.name === ref.entity);
      return (
        entity !== undefined &&
        entity.attributes.some((a) => a.name === ref.attribute)
      );
    }
    case 'RELATIONSHIP':
      return model.relationships.some(
        (r) => r.source === ref.source && r.target === ref.target,
      );
  }
}

/** Map an invariant violation to the element it concerns, for conflict reporting. */
function violationToElement(v: InvariantViolation): ModelElementRef {
  switch (v.invariant) {
    case 'I1':
      return { kind: 'ENTITY', entity: v.entity };
    case 'I2':
    case 'I5':
      return { kind: 'ATTRIBUTE', entity: v.entity, attribute: v.attribute };
    case 'I3':
    case 'I4':
    case 'I6':
      return {
        kind: 'RELATIONSHIP',
        source: v.relationship.source,
        target: v.relationship.target,
      };
  }
}

// ---------------------------------------------------------------------------
// deriveQuestions (Req 8.1, 8.2)
// ---------------------------------------------------------------------------

/**
 * Build the "add audit timestamps" opt-in question for an entity. Grounded in
 * the entity; the affirmative option adds `created_at` and `updated_at`
 * TIMESTAMP attributes to that entity (Req 8.4).
 */
function timestampsQuestion(entity: Entity, id: string): ClarifyingQuestion {
  const addition: FeatureAddition = {
    attributes: [
      {
        entity: entity.name,
        attribute: { name: 'created_at', dataType: 'TIMESTAMP', constraints: [] },
      },
      {
        entity: entity.name,
        attribute: { name: 'updated_at', dataType: 'TIMESTAMP', constraints: [] },
      },
    ],
  };
  return {
    id,
    prompt: `Add audit timestamps (created_at, updated_at) to "${entity.name}"?`,
    groundedIn: [{ kind: 'ENTITY', entity: entity.name }],
    options: [
      {
        id: 'yes',
        label: 'Yes, track created/updated times',
        effect: { kind: 'ADD_FEATURE', addition },
      },
      { id: 'no', label: 'No, leave as is', effect: { kind: 'NONE' } },
    ],
  };
}

/**
 * Build the "add a soft-delete flag" opt-in question for an entity. Grounded in
 * the entity; the affirmative option adds an `is_deleted` BOOLEAN attribute
 * (Req 8.4).
 */
function softDeleteQuestion(entity: Entity, id: string): ClarifyingQuestion {
  const addition: FeatureAddition = {
    attributes: [
      {
        entity: entity.name,
        attribute: { name: 'is_deleted', dataType: 'BOOLEAN', constraints: [] },
      },
    ],
  };
  return {
    id,
    prompt: `Enable soft deletes (an is_deleted flag) for "${entity.name}"?`,
    groundedIn: [{ kind: 'ENTITY', entity: entity.name }],
    options: [
      {
        id: 'yes',
        label: 'Yes, keep deleted rows with a flag',
        effect: { kind: 'ADD_FEATURE', addition },
      },
      { id: 'no', label: 'No, delete rows outright', effect: { kind: 'NONE' } },
    ],
  };
}

/**
 * Build a confirmation question for a relationship. Grounded in the
 * relationship; both options are no-ops (the question records intent without
 * mutating the model).
 */
function relationshipQuestion(
  rel: Relationship,
  id: string,
): ClarifyingQuestion {
  return {
    id,
    prompt: `Keep the ${rel.cardinality} relationship from "${rel.source}" to "${rel.target}"?`,
    groundedIn: [
      { kind: 'RELATIONSHIP', source: rel.source, target: rel.target },
    ],
    options: [
      { id: 'keep', label: 'Yes, keep it', effect: { kind: 'NONE' } },
      { id: 'review', label: 'Flag for review', effect: { kind: 'NONE' } },
    ],
  };
}

/**
 * Derive between 1 and {@link MAX_QUESTIONS} clarifying questions, each grounded
 * in an entity or relationship of the current model (Req 8.1). When the model
 * has no entities, attributes, or relationships from which a question can be
 * derived, return zero questions so the caller proceeds with the model as-is
 * (Req 8.2).
 *
 * Pure: does not mutate the model. Questions are emitted in a deterministic
 * order — per-entity opt-in features first, then relationship confirmations —
 * and the list is capped at {@link MAX_QUESTIONS}. As a final safeguard, any
 * question whose grounding does not resolve against the model is dropped, so
 * every returned question is provably grounded (Property 35).
 */
export function deriveQuestions(model: DataModel): ClarifyingQuestion[] {
  const questions: ClarifyingQuestion[] = [];
  let seq = 0;
  const nextId = (): string => `q-${(seq += 1)}`;

  // Per-entity opt-in feature questions (each grounded in its entity).
  for (const entity of model.entities) {
    if (questions.length >= MAX_QUESTIONS) {
      break;
    }
    questions.push(timestampsQuestion(entity, nextId()));
    if (questions.length >= MAX_QUESTIONS) {
      break;
    }
    questions.push(softDeleteQuestion(entity, nextId()));
  }

  // Relationship confirmation questions fill any remaining room.
  for (const rel of model.relationships) {
    if (questions.length >= MAX_QUESTIONS) {
      break;
    }
    questions.push(relationshipQuestion(rel, nextId()));
  }

  // Defensive grounding guarantee: keep only questions whose references resolve.
  return questions
    .filter(
      (q) =>
        q.groundedIn.length > 0 &&
        q.groundedIn.every((ref) => refExists(model, ref)),
    )
    .slice(0, MAX_QUESTIONS);
}

// ---------------------------------------------------------------------------
// applyAnswers (Req 8.3, 8.4, 8.5, 8.6)
// ---------------------------------------------------------------------------

/**
 * Apply a feature addition to the working (cloned) model, detecting conflicts
 * against what is already present. Returns a `RefinementConflict` on the first
 * contradiction, leaving conflict handling (and thus the unchanged-model
 * guarantee) to the caller. On success the additions are applied in place to
 * `working` and `undefined` is returned.
 */
function applyAddition(
  working: DataModel,
  addition: FeatureAddition,
  questionId: string,
  optionId: string,
): RefinementConflict | undefined {
  // 1) New entities. A name collision with a *different* shape is a conflict;
  //    an identical entity is simply retained (not duplicated) — Req 8.3.
  for (const newEntity of addition.entities ?? []) {
    const existing = working.entities.find((e) => e.name === newEntity.name);
    if (existing) {
      if (!entityStructurallyEqual(existing, newEntity)) {
        return {
          reason: 'ENTITY_CONFLICT',
          message: `Cannot add entity "${newEntity.name}": an entity with that name already exists with a different definition.`,
          element: { kind: 'ENTITY', entity: newEntity.name },
          questionId,
          optionId,
        };
      }
    } else {
      working.entities.push(JSON.parse(JSON.stringify(newEntity)) as Entity);
    }
  }

  // 2) New attributes on existing entities. A same-name attribute with a
  //    different data type is a conflict; identical is retained — Req 8.3.
  for (const { entity, attribute } of addition.attributes ?? []) {
    const ent = working.entities.find((e) => e.name === entity);
    if (ent === undefined) {
      return {
        reason: 'MISSING_TARGET',
        message: `Cannot add attribute "${attribute.name}": target entity "${entity}" is not in the model.`,
        element: { kind: 'ENTITY', entity },
        questionId,
        optionId,
      };
    }
    const existingAttr = ent.attributes.find((a) => a.name === attribute.name);
    if (existingAttr) {
      if (existingAttr.dataType !== attribute.dataType) {
        return {
          reason: 'ATTRIBUTE_CONFLICT',
          message: `Cannot add attribute "${entity}.${attribute.name}": it already exists with data type "${existingAttr.dataType}".`,
          element: { kind: 'ATTRIBUTE', entity, attribute: attribute.name },
          questionId,
          optionId,
        };
      }
    } else {
      ent.attributes.push(JSON.parse(JSON.stringify(attribute)) as Attribute);
    }
  }

  // 3) New relationships. Endpoints must exist (referential closure, I6); a
  //    relationship between the same endpoints with a different cardinality is
  //    a conflict; identical is retained — Req 8.3.
  for (const newRel of addition.relationships ?? []) {
    if (!hasEntity(working, newRel.source) || !hasEntity(working, newRel.target)) {
      return {
        reason: 'MISSING_TARGET',
        message: `Cannot add relationship "${newRel.source}" -> "${newRel.target}": one or both endpoints are not in the model.`,
        element: {
          kind: 'RELATIONSHIP',
          source: newRel.source,
          target: newRel.target,
        },
        questionId,
        optionId,
      };
    }
    const existing = working.relationships.find(
      (r) => r.source === newRel.source && r.target === newRel.target,
    );
    if (existing) {
      if (existing.cardinality !== newRel.cardinality) {
        return {
          reason: 'RELATIONSHIP_CONFLICT',
          message: `Cannot add relationship "${newRel.source}" -> "${newRel.target}" as ${newRel.cardinality}: it already exists as ${existing.cardinality}.`,
          element: {
            kind: 'RELATIONSHIP',
            source: newRel.source,
            target: newRel.target,
          },
          questionId,
          optionId,
        };
      }
    } else {
      working.relationships.push({ ...newRel });
    }
  }

  return undefined;
}

/**
 * Apply selected answers to the model, returning the refined model (Req 8.3,
 * 8.4) or a conflict that leaves the model unchanged (Req 8.5).
 *
 * Behavior:
 * - Empty answers represent the skip path: the initial model is returned
 *   unchanged (Req 8.6 / Property 37's "no change" baseline).
 * - Otherwise every selected option's effect is applied to a *clone* of the
 *   model. All prior elements are carried over and only retained-or-added — an
 *   element is never dropped (Req 8.3). Opt-in feature options contribute new
 *   entities/attributes/relationships (Req 8.4).
 * - The first contradiction (entity/attribute/relationship that conflicts with
 *   an existing element, a missing target, or a resulting invariant violation)
 *   aborts the whole operation: the input model is left exactly unchanged and
 *   the conflicting element is reported (Req 8.5 / Property 37). Because all
 *   work happens on the clone, the caller's model is never touched on the error
 *   path.
 *
 * Any successfully returned model still satisfies the Data_Model invariants
 * I1–I6.
 */
export function applyAnswers(
  model: DataModel,
  answers: Answer[],
): Result<DataModel, RefinementConflict> {
  // Skip path / no selections: proceed with the initial model unchanged.
  if (answers.length === 0) {
    return ok(model);
  }

  const working = cloneModel(model);

  for (const answer of answers) {
    for (const option of answer.selectedOptions) {
      if (option.effect.kind === 'NONE') {
        continue;
      }
      const conflict = applyAddition(
        working,
        option.effect.addition,
        answer.questionId,
        option.id,
      );
      if (conflict !== undefined) {
        // Fail closed: the input model is untouched (all work was on the clone).
        return err(conflict);
      }
    }
  }

  // The refined model must remain well-formed (I1–I6). If an answer's additions
  // would break an invariant, reject it and leave the input model unchanged.
  const validated = validateDataModel(working);
  if (isErr(validated)) {
    const first = validated.error[0];
    return err({
      reason: 'INVARIANT_VIOLATION',
      message: `Applying the selected answers would violate invariant ${first.invariant}: ${first.message}`,
      element: violationToElement(first),
    });
  }

  return ok(working);
}

// ---------------------------------------------------------------------------
// Ergonomic helpers
// ---------------------------------------------------------------------------

/**
 * Build an {@link Answer} selecting a single option of a question by id. A
 * convenience for callers (and tests) that have a {@link ClarifyingQuestion} in
 * hand. Returns `undefined` when the option id is not on the question.
 */
export function selectOption(
  question: ClarifyingQuestion,
  optionId: string,
): Answer | undefined {
  const option = question.options.find((o) => o.id === optionId);
  if (option === undefined) {
    return undefined;
  }
  return { questionId: question.id, selectedOptions: [option] };
}

// ---------------------------------------------------------------------------
// RefinementEngine (interface-shaped wrapper)
// ---------------------------------------------------------------------------

/**
 * The Refinement_Engine surface from the design. The refinement logic is pure
 * and stateless, so this class is a thin wrapper over the exported functions,
 * provided for parity with the design's `RefinementEngine` interface and for
 * call sites that prefer an object.
 */
export class RefinementEngine {
  /** Req 8.1, 8.2 — derive 0..10 grounded clarifying questions. */
  deriveQuestions(model: DataModel): ClarifyingQuestion[] {
    return deriveQuestions(model);
  }

  /** Req 8.3, 8.4, 8.5, 8.6 — apply answers or report a conflict. */
  applyAnswers(
    model: DataModel,
    answers: Answer[],
  ): Result<DataModel, RefinementConflict> {
    return applyAnswers(model, answers);
  }
}
