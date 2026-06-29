/**
 * The Modeling_Engine: turns unstructured input into a structured, validated
 * Data_Model. This file implements the *input validation* gate that runs
 * before the LLM is ever called (Requirements 1.6, 1.7) and defines the
 * `ModelingError` taxonomy and the `ModelingEngine` surface.
 *
 * Scope note: deterministic post-processing of the LLM's raw candidate model
 * (normalization, primary-key synthesis, cardinality normalization, join-entity
 * materialization) is implemented in task 2.2, and constraint inference
 * (unique / not-null / email-format / numeric-range and foreign keys for
 * ordinary relationships) in task 2.3. `inferFromPrompt` validates input, then
 * normalizes and constraint-enriches the LLM's raw candidate into a fully
 * well-formed `DataModel`.
 */
import type { DataModel } from '../model/types.js';
import { type Result } from '../model/result.js';
import type { ExtractedRecord } from '../document/documentParser.js';
import type { LlmClient } from './llmClient.js';
import { type SeedData, type SheetInput } from './records.js';
/**
 * The maximum allowed length of a domain description, in characters
 * (Requirement 1.7). Descriptions longer than this are rejected before the LLM
 * is called.
 */
export declare const MAX_PROMPT_LENGTH = 10000;
/**
 * Typed errors the Modeling_Engine returns through `Result`. The two
 * input-validation cases are produced before any LLM call (Requirements 1.6,
 * 1.7); `NO_DATA_MODEL` is the fail-closed outcome when no entity can be
 * inferred (Requirement 1.8, implemented in task 2.2).
 */
export type ModelingError = 
/** The description was empty or contained only whitespace (Req 1.6). */
{
    kind: 'EMPTY_INPUT';
    message: string;
}
/** The description exceeded the maximum allowed length (Req 1.7). */
 | {
    kind: 'INPUT_TOO_LONG';
    message: string;
    maxLength: number;
    actualLength: number;
}
/** No Data_Model could be derived from the description (Req 1.8). */
 | {
    kind: 'NO_DATA_MODEL';
    message: string;
};
/**
 * Validate a raw domain description before it is handed to the LLM.
 *
 * - Rejects empty or whitespace-only input with an `EMPTY_INPUT` error
 *   identifying that a non-empty description is required (Requirement 1.6).
 * - Rejects input longer than {@link MAX_PROMPT_LENGTH} with an
 *   `INPUT_TOO_LONG` error citing the maximum allowed length (Requirement 1.7).
 *
 * On success it returns the original (untrimmed) prompt so callers preserve the
 * builder's exact wording when prompting the LLM. No Data_Model is produced on
 * any error path (fail closed).
 */
export declare function validatePromptInput(prompt: string): Result<string, ModelingError>;
/**
 * The Modeling_Engine. Constructed with an `LlmClient` (stubbed in tests) that
 * supplies raw candidate models; the engine validates input and — once task
 * 2.2 lands — normalizes the raw candidate into a well-formed `DataModel`.
 */
export declare class ModelingEngine {
    private readonly llm;
    constructor(llm: LlmClient);
    /**
     * Infer a Data_Model from a natural-language domain description
     * (Requirement 1).
     *
     * The input-validation gate runs first (Requirements 1.6, 1.7): empty,
     * whitespace-only, and over-length descriptions are rejected here before the
     * LLM is called, with no Data_Model produced. The LLM then emits a raw
     * candidate model, which deterministic post-processing
     * ({@link normalizeCandidate}) normalizes into a well-formed `DataModel`
     * satisfying invariants I1–I6 — assigning exactly one primary key per entity
     * (synthesizing a surrogate when none is inferred), normalizing relationship
     * cardinality, assigning a supported data type to every attribute, and
     * materializing a join entity for each many-to-many relationship
     * (Requirements 1.1–1.5, 2.6). When no entity can be inferred it fails closed
     * with a `NO_DATA_MODEL` error and produces no partial model (Requirement 1.8).
     *
     * Constraint inference (unique / not-null / email-format / numeric-range and
     * foreign keys for ordinary relationships) is layered on in task 2.3.
     */
    inferFromPrompt(prompt: string): Promise<Result<DataModel, ModelingError>>;
    /**
     * Infer a Data_Model from records extracted from an uploaded document
     * (Requirements 10.2, 10.3) — the document-derived path [SECONDARY].
     *
     * Unlike {@link inferFromPrompt}, this path is fully deterministic and does
     * NOT call the LLM: relational decomposition of the flat records is
     * rule-based (see `inferModelFromRecords`). It detects repeating field groups
     * — sets of two or more fields whose combined values repeat across two or
     * more records — and extracts each into its own related entity rather than
     * modeling the source as a single flat table (Req 10.2). The result is run
     * through the same normalization, constraint-inference, and invariant
     * validation pipeline as the prompt path, so a document-derived model
     * satisfies the same structural invariants I1–I6 and is identical in shape to
     * a prompt-derived model (Req 10.3). It fails closed with `NO_DATA_MODEL`
     * when no entity can be derived (e.g. empty records).
     */
    inferFromRecords(records: ExtractedRecord[]): Promise<Result<DataModel, ModelingError>>;
    /**
     * Like {@link inferFromRecords}, but also returns the {@link SeedData} rows
     * that load the document's actual records into the generated backend (the
     * document-to-backend path's data, not just its schema). The model is
     * identical to what {@link inferFromRecords} produces.
     */
    inferAndSeedFromRecords(records: ExtractedRecord[]): Promise<Result<{
        model: DataModel;
        seed: SeedData;
    }, ModelingError>>;
    /**
     * Infer a Data_Model + seed from a multi-sheet workbook: each sheet becomes
     * its own entity and cross-sheet foreign keys are inferred by column naming
     * (Req 10, multi-sheet extension). Falls back to single-sheet decomposition
     * when only one sheet has data.
     */
    inferAndSeedFromSheets(sheets: SheetInput[]): Promise<Result<{
        model: DataModel;
        seed: SeedData;
    }, ModelingError>>;
}
