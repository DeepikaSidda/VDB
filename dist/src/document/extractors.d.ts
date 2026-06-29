/**
 * Real Excel and PDF extractors for the Document_Parser (Requirement 10.1).
 *
 * - Excel (.xlsx/.xls): parsed synchronously with SheetJS (`xlsx`) — the first
 *   worksheet's header row becomes the field names, each subsequent row a
 *   record. Plugged into {@link DocumentParser} as its `excelExtractor`.
 * - PDF: extracted asynchronously with `pdf-parse`. Because PDF text extraction
 *   is async (and the Document_Parser's `parse` is synchronous), PDF is handled
 *   through the async {@link extractPdfRecords} helper used by the pipeline's
 *   document path rather than as a synchronous parser extractor. PDF table
 *   recovery is inherently best-effort: clean, delimited tables parse well;
 *   scanned or free-form invoices may not yield structured rows.
 */
import type { ContentExtractor, ExtractedRecord, UploadedFile } from './documentParser.js';
/**
 * Extract records from an Excel workbook's first sheet (Requirement 10.1).
 * Header row → field names; following rows → records keyed by header.
 */
export declare const xlsxExtractor: ContentExtractor;
/** One worksheet's extracted records, tagged with the sheet (table) name. */
export type SheetRecords = {
    name: string;
    records: ExtractedRecord[];
};
/**
 * Extract records from EVERY non-empty worksheet of a workbook (Requirement
 * 10.1, multi-sheet extension). Each sheet becomes a candidate table: the
 * pipeline maps each to its own entity and infers relationships between them by
 * foreign-key naming. Sheets with no data rows are dropped. Sheet names are
 * trimmed; empty/duplicate names are disambiguated so each entity is distinct.
 */
export declare function xlsxSheets(file: UploadedFile): SheetRecords[];
/**
 * Extract records from a PDF (best-effort). Uses `pdf-parse` v2's `PDFParse`
 * class: first it attempts structured TABLE extraction (which recovers real
 * rows/columns from ruled or aligned tables in invoices, registration forms,
 * etc.), and falls back to text-layer heuristics ({@link pdfTextToRecords})
 * when no usable table is found. Returns `[]` when nothing tabular is present.
 *
 * The module is imported with a literal specifier and marked as an external
 * server package (see web/next.config.mjs), so the bundler resolves the real
 * `pdf-parse` (and its pdfjs-dist engine) from node_modules at runtime instead
 * of trying to bundle it.
 */
export declare function extractPdfRecords(bytes: Uint8Array): Promise<ExtractedRecord[]>;
/**
 * Convert one extracted table (rows of string cells) into records: the first
 * non-empty row is the header, each following row a record keyed by it. Rows
 * whose length doesn't match the header are skipped. Returns `[]` for a table
 * with fewer than two rows or fewer than two columns.
 */
export declare function tableToRecords(table: readonly string[][]): ExtractedRecord[];
/**
 * Parse plain text extracted from a PDF into records. Splits into non-empty
 * lines, infers a delimiter (comma, tab, pipe, or runs of 2+ spaces), and uses
 * the first line as the header. Lines whose column count doesn't match the
 * header are skipped. Returns `[]` if fewer than two usable lines exist.
 */
export declare function pdfTextToRecords(text: string): ExtractedRecord[];
