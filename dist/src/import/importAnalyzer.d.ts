/**
 * Import_Analyzer (Requirement 11) — STRETCH.
 *
 * Analyzes an existing external MySQL/PostgreSQL database and produces a
 * dialect-independent {@link DataModel} plus a set of improvement suggestions:
 *
 * - `importSchema(creds)` connects within 30s, introspects the source schema
 *   (tables/columns/types/PKs/FKs/indexes), and maps it into a Data_Model
 *   (Req 11.1). A source column whose type (or any element) cannot be mapped is
 *   recorded with a not-extracted indicator and extraction CONTINUES (Req 11.2).
 *   On a connect failure it distinguishes a connection timeout from an
 *   authentication failure (Req 11.5) and returns an error — because the result
 *   is a fresh value carried only on the success branch, any pre-existing
 *   Data_Model the caller holds is left unchanged.
 * - `suggest(model)` inspects a Data_Model and returns improvement suggestions
 *   covering missing primary keys, missing foreign keys, and normalization up
 *   to third normal form (Req 11.3); each suggestion identifies the affected
 *   element, the detected issue, and the proposed change.
 *
 * Like the {@link import('../provisioner/provisioner.js').Provisioner}, this
 * stays unit-testable without a live connection by depending only on the
 * injected {@link SourceDbDriver} port and an injectable {@link Clock} (see
 * ./sourceDriver.ts). Tests supply the {@link InMemorySource} fake; a real
 * driver-backed adapter (./pgSource.ts) is a documented placeholder.
 *
 * Note on the interface: the design sketches `importSchema` as synchronous, but
 * connecting to a live database is asynchronous, so — mirroring the Provisioner
 * — the method is `async` and returns a `Promise<Result<...>>`. The success
 * value is an {@link ImportResult} (the model plus the explicit `notExtracted`
 * list) rather than a bare `DataModel`, so the not-extracted indicators of
 * Req 11.2 are first-class; the affected attributes are also flagged
 * `needsReview` in the model itself.
 */
import type { DataModel, DataType, DbCredentials } from '../model/types.js';
import { type Result } from '../model/result.js';
import { type Clock, type SourceDbDriver } from './sourceDriver.js';
/**
 * The error conditions an import can fail with, discriminated on `kind`.
 * Req 11.5 requires distinguishing a connection timeout from an authentication
 * failure; `EXTRACTION_FAILURE` covers an unexpected failure while reading the
 * schema after a successful connect.
 */
export type ImportError = {
    kind: 'CONNECTION_TIMEOUT';
    message: string;
} | {
    kind: 'AUTHENTICATION_FAILURE';
    message: string;
} | {
    kind: 'EXTRACTION_FAILURE';
    message: string;
};
/**
 * A schema element that was encountered but could not be fully extracted into
 * the Data_Model (Req 11.2). Extraction records it and continues; the affected
 * attribute (when applicable) is also flagged `needsReview` in the model.
 */
export type NotExtractedElement = {
    /** What kind of element was not extracted. */
    element: 'COLUMN_TYPE';
    /** The source table the element belongs to. */
    table: string;
    /** The source column, when the element is column-scoped. */
    column: string;
    /** Human-readable reason, including the raw source value. */
    detail: string;
};
/**
 * The successful result of importing a schema: the reconstructed Data_Model
 * plus the explicit list of elements that were recorded but not extracted
 * (Req 11.2).
 */
export type ImportResult = {
    model: DataModel;
    notExtracted: NotExtractedElement[];
};
/** The category of an improvement suggestion. */
export type SuggestionKind = 'MISSING_PRIMARY_KEY' | 'MISSING_FOREIGN_KEY' | 'NORMALIZATION';
/** A reference to the Data_Model element a suggestion concerns. */
export type ElementRef = {
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
 * A single improvement suggestion. Each identifies the affected schema element,
 * the detected issue, and the proposed change (Req 11.3). Suggestions are
 * advisory: the Schema_Generator only acts on the ones the user accepts
 * (Req 11.4, task 15.2 / the [MUST] pipeline).
 */
export type ImprovementSuggestion = {
    kind: SuggestionKind;
    element: ElementRef;
    /** The detected issue. */
    issue: string;
    /** The proposed change that would resolve the issue. */
    proposedChange: string;
};
/**
 * Map a raw source column type to a Data_Model {@link DataType}, or
 * `undefined` when it is unsupported (the Req 11.2 not-extracted condition).
 */
export declare function mapSourceType(rawType: string): DataType | undefined;
/** The Import_Analyzer contract (Req 11). */
export interface ImportAnalyzer {
    importSchema(creds: DbCredentials): Promise<Result<ImportResult, ImportError>>;
    suggest(model: DataModel): ImprovementSuggestion[];
}
/**
 * Dependency-injected implementation of the {@link ImportAnalyzer}. Construct
 * it with a {@link SourceDbDriver} (in-memory fake in tests, real adapter in
 * production) and optionally a {@link Clock} for deterministic timeout logic.
 */
export declare class SourceImportAnalyzer implements ImportAnalyzer {
    private readonly driver;
    private readonly clock;
    constructor(driver: SourceDbDriver, clock?: Clock);
    importSchema(creds: DbCredentials): Promise<Result<ImportResult, ImportError>>;
    suggest(model: DataModel): ImprovementSuggestion[];
}
