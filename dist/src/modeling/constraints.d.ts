/**
 * Constraint inference (task 2.3): layers `AttributeConstraint`s onto a
 * *structurally* normalized `DataModel` (the output of `normalizeCandidate`).
 *
 * `normalize.ts` guarantees the structural invariants I1–I6 (one PK per
 * entity, supported data types, valid cardinality, materialized M:N join
 * entities with their foreign keys). This module is responsible for the
 * *semantic* constraints of Requirement 2:
 *
 *  - UNIQUE (Req 2.1)        — from the raw candidate's advisory `unique` hint
 *                              and uniquely-identifying name heuristics.
 *  - NOT_NULL (Req 2.2)      — from the advisory `required` hint and the rule
 *                              that primary-key columns are not-null.
 *  - FORMAT EMAIL (Req 2.3)  — for attributes whose name denotes an email
 *                              address. The accept/reject rule is implemented
 *                              by {@link isValidEmail} (it backs Property 7 and
 *                              is reused by the API validation layer).
 *  - RANGE min 0 (Req 2.4)   — for numeric count/quantity/age/price-style
 *                              attributes with a natural lower bound.
 *  - FOREIGN_KEY (Req 2.5)   — for ordinary (non-join) relationships, a foreign
 *                              key on the dependent entity referencing the
 *                              related entity's primary key. Join-entity FKs
 *                              are already produced by `normalize.ts` and are
 *                              not duplicated here.
 *  - needsReview (Req 2.7)   — low-confidence attributes are flagged for
 *                              builder review rather than having a constraint
 *                              guessed for them.
 *
 * The module is a pure function of its inputs: it returns a new `DataModel`
 * and never mutates the model handed in. The result still satisfies the
 * Data_Model invariants I1–I6.
 */
import type { DataModel } from '../model/types.js';
import type { RawCandidateModel } from './llmClient.js';
/**
 * The email-format predicate backing the `FORMAT: 'EMAIL'` constraint
 * (Requirement 2.3, Property 7). It is the single source of truth for what
 * counts as a well-formed email and is reused by the API validation layer.
 *
 * A value is accepted **if and only if** it contains exactly one `"@"`
 * separating a non-empty local part from a domain part that contains at least
 * one `"."`. Every other value is rejected.
 *
 * Note: this is intentionally the literal rule from Requirement 2.3, not a
 * fuller RFC 5322 grammar — matching the requirement exactly is what Property 7
 * verifies.
 */
export declare function isValidEmail(value: string): boolean;
/**
 * Enrich a structurally-normalized `DataModel` with the semantic constraints
 * of Requirement 2 (unique, not-null, email format, numeric range, and the
 * foreign keys for ordinary relationships), flagging low-confidence attributes
 * for builder review (Req 2.7).
 *
 * Pure: returns a new `DataModel` and does not mutate `model`. The advisory
 * `unique`/`required` hints are read from the original `raw` candidate (by
 * entity/attribute name) when supplied. The result preserves invariants I1–I6.
 */
export declare function inferConstraints(model: DataModel, raw?: RawCandidateModel): DataModel;
