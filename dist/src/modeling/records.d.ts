/**
 * Deterministic relational decomposition of flat, tabular records into a
 * well-formed `DataModel` (Requirements 10.2, 10.3) — the document-derived
 * path of the Modeling_Engine [SECONDARY].
 *
 * The Document_Parser produces `ExtractedRecord[]` (rows of named fields).
 * A naive translation would model every dataset as a single flat table, which
 * loses the relational structure that is actually present: when a *group* of
 * two or more fields carries values that repeat across two or more records,
 * those fields describe a separate real-world entity (e.g. the
 * `{facultyName, facultyDept}` of an attendance sheet), not per-row data.
 * Requirement 10.2 mandates that such a group becomes its OWN entity rather
 * than columns of one flat table.
 *
 * This module is deliberately **deterministic and LLM-free**: the
 * decomposition is rule-based so it is fully testable (Property 41). It:
 *
 *  1. Infers each field's `DataType` from its sample values (Req 10.3).
 *  2. Detects repeating field GROUPS via functional-dependency clustering
 *     (see {@link detectRepeatingGroups}) and extracts each into its own
 *     entity (Req 10.2).
 *  3. Builds a main entity from the remaining fields and relates each
 *     extracted entity to it with a ONE_TO_MANY relationship.
 *  4. Runs the assembled candidate through the SAME deterministic
 *     normalization + constraint-inference + invariant-validation pipeline
 *     used by `inferFromPrompt`, so a document-derived model is structurally
 *     identical in shape to a prompt-derived one and satisfies the same
 *     invariants I1–I6 (Req 10.3).
 *
 * It follows the fail-closed `Result` discipline: an empty/field-less input
 * yields a `NO_DATA_MODEL` error and no partial model.
 */
import type { DataModel, DataType } from '../model/types.js';
import { type Result } from '../model/result.js';
import type { ExtractedRecord } from '../document/documentParser.js';
import type { ModelingError } from './modelingEngine.js';
/**
 * Infer one supported `DataType` for a field from its sample values
 * (Requirement 10.3).
 *
 * Blank values are ignored. A field with no informative values defaults to
 * `TEXT` (the most permissive supported type). When every informative value
 * shares a category that category wins; mixed-but-compatible categories widen
 * (INTEGER + NUMERIC → NUMERIC; DATE + TIMESTAMP → TIMESTAMP); any other mix
 * falls back to `TEXT`.
 */
export declare function inferFieldType(values: readonly unknown[]): DataType;
/**
 * The ordered set of field names across all records (union of keys, in
 * first-seen order so the model's column order is stable and reproducible).
 */
export declare function collectFieldNames(records: readonly ExtractedRecord[]): string[];
/**
 * A repeating field group: a set of two or more fields whose combined values
 * repeat across two or more records, indicating a separate entity.
 */
export type RepeatingGroup = {
    /** The member field names, in the model's column order. */
    fields: string[];
};
/**
 * Detect repeating field groups (Requirement 10.2, Property 41).
 *
 * Heuristic — functional-dependency clustering by partition signature:
 *  1. Group fields that induce the identical row partition (same signature).
 *     Such fields covary perfectly, so they describe one shared sub-entity.
 *  2. Keep a cluster only when it (a) has two or more fields AND (b) actually
 *     *repeats* — i.e. its number of distinct value-combinations is fewer than
 *     the record count, so at least one combination is shared by two or more
 *     records. A cluster of two all-distinct (key-like) fields is therefore
 *     NOT extracted, because nothing repeats.
 *
 * This deterministically detects any planted group whose 2+ fields share
 * repeated value-combinations across 2+ rows (the Property 41 generator shape:
 * each row references one of several reused sub-entity instances).
 */
export declare function detectRepeatingGroups(records: readonly ExtractedRecord[], fieldNames: readonly string[]): RepeatingGroup[];
/** A single seed row destined for an entity's CRUD store. */
export type SeedRecord = Record<string, unknown>;
/**
 * The rows to load into the generated backend after the schema is built, keyed
 * by entity name. Entries are ordered so that referenced (group) entities come
 * before the main entity, so foreign-key existence checks pass when the main
 * rows are seeded.
 */
export type SeedData = Map<string, SeedRecord[]>;
/** The model plus the seed rows derived from the same source records. */
export type ModelAndSeed = {
    model: DataModel;
    seed: SeedData;
};
/**
 * Decompose flat extracted records into a well-formed `DataModel` **and** the
 * seed rows that load the source data into the generated backend.
 *
 * Same decomposition + normalization + constraint-inference + invariant
 * validation pipeline as {@link inferModelFromRecords}; additionally it derives
 * a {@link SeedData} map so the document's actual rows populate the entities
 * (each repeating group's distinct tuples become group rows; every source row
 * becomes a main row linked to its group rows by the inferred foreign keys).
 * Fails closed with `NO_DATA_MODEL` exactly as the model-only path does.
 */
export declare function inferModelAndSeedFromRecords(records: readonly ExtractedRecord[]): Result<ModelAndSeed, ModelingError>;
/**
 * Decompose flat extracted records into a well-formed `DataModel`.
 *
 * Fails closed with `NO_DATA_MODEL` when no entity can be derived — an empty
 * record list or records with no named fields (Req 1.8 discipline applied to
 * the document path). Otherwise it assembles a raw candidate (splitting out
 * repeating field groups, Req 10.2) and runs it through the same
 * normalization + constraint-inference + invariant-validation pipeline as the
 * prompt path, so the result satisfies invariants I1–I6 and is structurally
 * identical in shape to a prompt-derived model (Req 10.3).
 *
 * This is the model-only projection of {@link inferModelAndSeedFromRecords};
 * it discards the derived seed rows.
 */
export declare function inferModelFromRecords(records: readonly ExtractedRecord[]): Result<DataModel, ModelingError>;
/** One worksheet's records, tagged with the sheet (table) name. */
export type SheetInput = {
    name: string;
    records: readonly ExtractedRecord[];
};
/**
 * Build a `DataModel` + {@link SeedData} from a multi-sheet workbook
 * (Requirement 10, multi-sheet extension). Each sheet becomes its own entity
 * (NOT decomposed — a workbook's sheets are already separate tables); columns
 * named like foreign keys (`customer_id`) that match another sheet's name are
 * wired as `FOREIGN_KEY` constraints + `ONE_TO_MANY` relationships, so the
 * cross-sheet relational structure is recovered. The source rows are seeded,
 * preserving each sheet's own id/foreign-key values so the links resolve.
 *
 * Falls back to {@link inferModelAndSeedFromRecords} (single-sheet
 * repeating-group decomposition) when only one sheet has data.
 */
export declare function inferModelAndSeedFromSheets(sheets: readonly SheetInput[]): Result<ModelAndSeed, ModelingError>;
