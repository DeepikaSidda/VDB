/**
 * Deterministic post-processing of a raw, untrusted `RawCandidateModel` (as
 * emitted by the LLM) into a well-formed `DataModel` that satisfies the IR
 * invariants I1–I6 (see `src/model/invariants.ts`).
 *
 * Design principle "Model first, generate second": the LLM's output is never
 * trusted blindly. This module repairs the *structural* guarantees the LLM may
 * miss — exactly one primary key per entity, a supported data type on every
 * attribute, a valid cardinality on every relationship, and a materialized
 * join entity (with foreign keys to both endpoints' primary keys) for every
 * many-to-many relationship.
 *
 * Scope (task 2.2): structural normalization only. *Constraint inference*
 * (unique / not-null / email-format / numeric-range, and foreign-key
 * constraints for ordinary relationships) is layered on top in task 2.3. The
 * one exception is the foreign keys on synthesized join entities, which are
 * structural and required for invariant I4, so they are produced here.
 *
 * The module is a pure function of its input and follows the fail-closed
 * `Result` discipline: it returns a `NO_DATA_MODEL` error (and no partial
 * model) when no entity can be inferred (Requirement 1.8).
 */
import type { DataModel, DataType, Relationship } from '../model/types.js';
import { type Result } from '../model/result.js';
import type { RawCandidateModel } from './llmClient.js';
import type { ModelingError } from './modelingEngine.js';
/**
 * Map a free-form data-type string onto exactly one supported `DataType`
 * (Requirement 1.4). Unknown or missing types default to `TEXT`.
 */
export declare function normalizeDataType(raw: string | undefined): DataType;
/**
 * Map a free-form cardinality label onto exactly one of the three allowed
 * cardinalities (Requirement 1.3). Unknown or missing labels default to
 * `ONE_TO_MANY`, the most common relational cardinality.
 */
export declare function normalizeCardinality(raw: string | undefined): Relationship['cardinality'];
/**
 * Normalize a raw candidate model into a well-formed `DataModel` satisfying
 * invariants I1–I6, or fail closed with a `NO_DATA_MODEL` error when no entity
 * can be inferred (Requirement 1.8).
 *
 * Steps:
 *  1. Normalize entities — drop nameless/duplicate entities; give every
 *     attribute a supported type; assign exactly one primary key per entity
 *     (synthesizing a surrogate when needed).
 *  2. Normalize relationships — map cardinality onto the three allowed values;
 *     drop relationships whose endpoints are not defined entities (so I6 holds).
 *  3. Materialize a join entity for each many-to-many relationship (I4).
 *
 * `validateDataModel` is run as a defensive post-condition: a correct
 * normalization of a non-empty model always passes, so a failure indicates an
 * internal bug and is reported fail-closed rather than emitting a malformed
 * model.
 */
export declare function normalizeCandidate(raw: RawCandidateModel): Result<DataModel, ModelingError>;
