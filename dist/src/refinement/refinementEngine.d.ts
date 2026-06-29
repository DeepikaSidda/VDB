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
import type { Attribute, DataModel, Entity, Relationship } from '../model/types.js';
import { type Result } from '../model/result.js';
/** The maximum number of clarifying questions to present (Req 8.1). */
export declare const MAX_QUESTIONS = 10;
/**
 * A reference to a single element of the Data_Model. Used both to express the
 * element(s) a clarifying question is grounded in (the "grounded" guarantee of
 * Req 8.1 / Property 35) and to identify the conflicting element when an answer
 * is rejected (Req 8.5 / Property 37).
 */
export type ModelElementRef = {
    kind: 'ENTITY';
    entity: string;
} | {
    kind: 'ATTRIBUTE';
    entity: string;
    attribute: string;
} | {
    kind: 'RELATIONSHIP';
    source: string;
    target: string;
};
/**
 * Elements an opt-in feature option contributes to the model when selected
 * (Req 8.4). Any subset may be present; an option that changes nothing carries
 * a `NONE` effect instead.
 */
export type FeatureAddition = {
    entities?: Entity[];
    attributes?: {
        entity: string;
        attribute: Attribute;
    }[];
    relationships?: Relationship[];
};
/**
 * The effect of selecting a particular option. `NONE` leaves the model
 * untouched (e.g. "keep as is"); `ADD_FEATURE` contributes the elements of an
 * opt-in feature (Req 8.4).
 */
export type AnswerEffect = {
    kind: 'NONE';
} | {
    kind: 'ADD_FEATURE';
    addition: FeatureAddition;
};
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
/**
 * The result of rejecting a conflicting answer. Identifies the conflicting
 * element so the UI can point the builder at it (Req 8.5). When an answer is
 * rejected, the model is left exactly unchanged (Property 37).
 */
export type RefinementConflict = {
    reason: 'ENTITY_CONFLICT' | 'ATTRIBUTE_CONFLICT' | 'RELATIONSHIP_CONFLICT' | 'MISSING_TARGET' | 'INVARIANT_VIOLATION';
    message: string;
    /** The element in the existing model that the answer contradicts. */
    element: ModelElementRef;
    /** The question whose answer produced the conflict, when known. */
    questionId?: string;
    /** The selected option that produced the conflict, when known. */
    optionId?: string;
};
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
export declare function deriveQuestions(model: DataModel): ClarifyingQuestion[];
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
export declare function applyAnswers(model: DataModel, answers: Answer[]): Result<DataModel, RefinementConflict>;
/**
 * Build an {@link Answer} selecting a single option of a question by id. A
 * convenience for callers (and tests) that have a {@link ClarifyingQuestion} in
 * hand. Returns `undefined` when the option id is not on the question.
 */
export declare function selectOption(question: ClarifyingQuestion, optionId: string): Answer | undefined;
/**
 * The Refinement_Engine surface from the design. The refinement logic is pure
 * and stateless, so this class is a thin wrapper over the exported functions,
 * provided for parity with the design's `RefinementEngine` interface and for
 * call sites that prefer an object.
 */
export declare class RefinementEngine {
    /** Req 8.1, 8.2 — derive 0..10 grounded clarifying questions. */
    deriveQuestions(model: DataModel): ClarifyingQuestion[];
    /** Req 8.3, 8.4, 8.5, 8.6 — apply answers or report a conflict. */
    applyAnswers(model: DataModel, answers: Answer[]): Result<DataModel, RefinementConflict>;
}
