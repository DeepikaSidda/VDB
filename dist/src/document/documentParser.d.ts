/**
 * The Document_Parser [SECONDARY]: extracts structured, named-field records
 * from uploaded files (Requirement 10). It is the first stage of the
 * document-to-backend path — the records it produces are handed to the
 * Modeling_Engine's `inferFromRecords` (task 14.2) to derive a Data_Model.
 *
 * Scope (task 14.1): accept CSV / Excel / PDF up to 50 MB and extract
 * named-field records (Req 10.1); reject unsupported formats (Req 10.4),
 * unparseable supported files (Req 10.5), empty extractions (Req 10.6), and
 * oversize files > 50 MB (Req 10.7). Every error path retains no records — the
 * parser returns an `err` Result, never a partial list (fail closed).
 *
 * Design notes:
 * - CSV is the primary, fully-implementable path and is parsed by a
 *   dependency-free reader that handles quoted fields, embedded commas, and
 *   embedded newlines. It works out of the box.
 * - Excel and PDF are *supported* formats (so they are never rejected as
 *   unsupported), but extracting them requires heavy parsing libraries that we
 *   deliberately keep out of the core for build safety. Instead the parser
 *   accepts optional injectable extractors (`excelExtractor`, `pdfExtractor`).
 *   When an Excel/PDF file arrives and no extractor is configured, the parser
 *   returns a `PARSE_FAILURE` (the format is supported, but it could not be
 *   parsed in this configuration) — never an `UNSUPPORTED_FORMAT` error.
 */
import { type Result } from '../model/result.js';
/** The maximum allowed upload size, in bytes: 50 MB (Requirement 10.7). */
export declare const MAX_FILE_SIZE_BYTES: number;
/** Human-readable list of the supported upload formats (Requirement 10.4). */
export declare const SUPPORTED_FORMATS: readonly ["CSV", "Excel", "PDF"];
/** The canonical, normalized format of a recognized upload. */
export type SupportedFormat = 'CSV' | 'EXCEL' | 'PDF';
/**
 * An uploaded file handed to the Document_Parser. `content` carries the raw
 * bytes (or, for CSV convenience, decoded text); `format`, `contentType`, and
 * the file extension in `name` are all consulted for format detection.
 */
export type UploadedFile = {
    /** Original file name, e.g. `customers.csv`. Used for extension detection. */
    name: string;
    /** Explicit format hint, e.g. `"csv"`, `"xlsx"`, `"pdf"` (optional). */
    format?: string;
    /** MIME content type, e.g. `"text/csv"` (optional). */
    contentType?: string;
    /**
     * Declared size in bytes (optional). When present it is authoritative for
     * the size check; otherwise the size is computed from `content`.
     */
    size?: number;
    /** Raw file content: decoded text or raw bytes. */
    content: string | Uint8Array;
};
/**
 * An extracted record: a set of named fields with their values. A flat tabular
 * source (CSV/sheet) produces one record per row keyed by the header row.
 */
export type ExtractedRecord = Record<string, unknown>;
/**
 * An injectable extractor for a binary format (Excel or PDF). It receives the
 * uploaded file and returns the extracted records. It may throw to signal an
 * unparseable file; the parser catches that and reports a `PARSE_FAILURE`.
 */
export type ContentExtractor = (file: UploadedFile) => ExtractedRecord[];
/**
 * Typed errors the Document_Parser returns through `Result`. Every variant is
 * fail-closed: no records are retained on any error.
 */
export type ParseError = 
/** The file's format is not CSV, Excel, or PDF (Requirement 10.4). */
{
    kind: 'UNSUPPORTED_FORMAT';
    message: string;
    supportedFormats: readonly string[];
}
/** A supported file could not be parsed (Requirement 10.5). */
 | {
    kind: 'PARSE_FAILURE';
    message: string;
}
/** The file parsed but contained no extractable records (Requirement 10.6). */
 | {
    kind: 'NO_RECORDS';
    message: string;
}
/** The file exceeds the 50 MB maximum (Requirement 10.7). */
 | {
    kind: 'FILE_TOO_LARGE';
    message: string;
    maxBytes: number;
    actualBytes: number;
};
/** Optional injectable extractors for the binary formats. */
export type DocumentParserOptions = {
    /** Extractor for Excel workbooks (.xlsx/.xls). */
    excelExtractor?: ContentExtractor;
    /** Extractor for PDF documents (.pdf). */
    pdfExtractor?: ContentExtractor;
};
/**
 * Determine a file's supported format from (in priority order) an explicit
 * `format` hint, the MIME `contentType`, and the file-name extension. Returns
 * `null` when the file is none of CSV / Excel / PDF.
 */
export declare function detectFormat(file: UploadedFile): SupportedFormat | null;
/**
 * Compute a file's size in bytes. A declared `size` is authoritative when
 * provided; otherwise the size is computed from `content` (UTF-8 byte length
 * for text, `byteLength` for raw bytes).
 */
export declare function fileSizeBytes(file: UploadedFile): number;
/**
 * Parse CSV text into rows of string cells, honoring RFC-4180-style quoting:
 * fields may be wrapped in double quotes, quoted fields may contain commas and
 * newlines, and a literal double quote inside a quoted field is written as two
 * double quotes (`""`). A trailing newline does not produce an empty trailing
 * row.
 */
export declare function parseCsv(text: string): string[][];
/**
 * The Document_Parser. CSV parsing works out of the box; Excel and PDF
 * extraction is delegated to injectable extractors supplied at construction so
 * the core stays dependency-free and testable.
 */
export declare class DocumentParser {
    private readonly excelExtractor?;
    private readonly pdfExtractor?;
    constructor(options?: DocumentParserOptions);
    /**
     * Extract named-field records from an uploaded file (Requirement 10).
     *
     * Order of checks (all fail closed — no records retained on error):
     * 1. Size: reject files larger than 50 MB before any parsing (Req 10.7).
     * 2. Format detection: reject anything that is not CSV/Excel/PDF (Req 10.4).
     * 3. Parse: CSV is parsed directly; Excel/PDF are delegated to their
     *    injectable extractor. A parse failure (including a missing extractor for
     *    a supported binary format) returns `PARSE_FAILURE` (Req 10.5).
     * 4. Empty extraction: a successful parse that yields zero records returns
     *    `NO_RECORDS` (Req 10.6).
     */
    parse(file: UploadedFile): Result<ExtractedRecord[], ParseError>;
    /**
     * Dispatch extraction by format. CSV is parsed in-process; Excel and PDF are
     * delegated to their injectable extractor, with a missing extractor surfaced
     * as a parse failure (the format is supported, but unparseable in this
     * configuration) — never an unsupported-format error.
     */
    private extract;
}
