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

import { type Result, err, ok } from '../model/result.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** The maximum allowed upload size, in bytes: 50 MB (Requirement 10.7). */
export const MAX_FILE_SIZE_BYTES = 50 * 1024 * 1024;

/** Human-readable list of the supported upload formats (Requirement 10.4). */
export const SUPPORTED_FORMATS = ['CSV', 'Excel', 'PDF'] as const;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

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
  | {
      kind: 'UNSUPPORTED_FORMAT';
      message: string;
      supportedFormats: readonly string[];
    }
  /** A supported file could not be parsed (Requirement 10.5). */
  | { kind: 'PARSE_FAILURE'; message: string }
  /** The file parsed but contained no extractable records (Requirement 10.6). */
  | { kind: 'NO_RECORDS'; message: string }
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

// ---------------------------------------------------------------------------
// Format detection
// ---------------------------------------------------------------------------

/**
 * Determine a file's supported format from (in priority order) an explicit
 * `format` hint, the MIME `contentType`, and the file-name extension. Returns
 * `null` when the file is none of CSV / Excel / PDF.
 */
export function detectFormat(file: UploadedFile): SupportedFormat | null {
  const hint = (file.format ?? '').trim().toLowerCase();
  const contentType = (file.contentType ?? '').trim().toLowerCase();
  const extension = extensionOf(file.name);

  // 1) Explicit format hint.
  if (hint) {
    if (hint === 'csv') return 'CSV';
    if (hint === 'excel' || hint === 'xlsx' || hint === 'xls') return 'EXCEL';
    if (hint === 'pdf') return 'PDF';
    // An explicit but unrecognized hint is decisive: unsupported.
    return null;
  }

  // 2) MIME content type.
  if (contentType) {
    if (contentType === 'text/csv' || contentType === 'application/csv') {
      return 'CSV';
    }
    if (
      contentType ===
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' ||
      contentType === 'application/vnd.ms-excel'
    ) {
      return 'EXCEL';
    }
    if (contentType === 'application/pdf') return 'PDF';
    // Fall through to extension detection for other content types.
  }

  // 3) File-name extension.
  switch (extension) {
    case 'csv':
      return 'CSV';
    case 'xlsx':
    case 'xls':
      return 'EXCEL';
    case 'pdf':
      return 'PDF';
    default:
      return null;
  }
}

/** Lowercased file extension without the dot, or `''` when none. */
function extensionOf(name: string): string {
  const lastDot = name.lastIndexOf('.');
  if (lastDot < 0 || lastDot === name.length - 1) return '';
  return name.slice(lastDot + 1).toLowerCase();
}

// ---------------------------------------------------------------------------
// Size computation
// ---------------------------------------------------------------------------

/**
 * Compute a file's size in bytes. A declared `size` is authoritative when
 * provided; otherwise the size is computed from `content` (UTF-8 byte length
 * for text, `byteLength` for raw bytes).
 */
export function fileSizeBytes(file: UploadedFile): number {
  if (typeof file.size === 'number' && Number.isFinite(file.size)) {
    return file.size;
  }
  if (typeof file.content === 'string') {
    // UTF-8 byte length, not character count.
    return Buffer.byteLength(file.content, 'utf8');
  }
  return file.content.byteLength;
}

// ---------------------------------------------------------------------------
// CSV parsing (dependency-free)
// ---------------------------------------------------------------------------

/**
 * Parse CSV text into rows of string cells, honoring RFC-4180-style quoting:
 * fields may be wrapped in double quotes, quoted fields may contain commas and
 * newlines, and a literal double quote inside a quoted field is written as two
 * double quotes (`""`). A trailing newline does not produce an empty trailing
 * row.
 */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let field = '';
  let row: string[] = [];
  let inQuotes = false;
  let sawAnyChar = false;

  const pushField = (): void => {
    row.push(field);
    field = '';
  };
  const pushRow = (): void => {
    pushField();
    rows.push(row);
    row = [];
  };

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    sawAnyChar = true;

    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          // Escaped quote inside a quoted field.
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      pushField();
    } else if (ch === '\n') {
      pushRow();
    } else if (ch === '\r') {
      // Swallow CR; a following LF triggers the row break. A lone CR also ends
      // the row.
      if (text[i + 1] === '\n') {
        // handled on next iteration by the \n branch
      } else {
        pushRow();
      }
    } else {
      field += ch;
    }
  }

  // Flush the final field/row unless the input ended exactly on a row break
  // (field empty and row empty) or the input was entirely empty.
  if (sawAnyChar && (field.length > 0 || row.length > 0)) {
    pushRow();
  }

  return rows;
}

/**
 * Convert parsed CSV rows into named-field records keyed by the header row.
 * Rows that are entirely empty are skipped. Short rows leave missing columns
 * absent; extra columns beyond the header are ignored.
 */
function csvRowsToRecords(rows: string[][]): ExtractedRecord[] {
  if (rows.length === 0) return [];

  const header = rows[0].map((h) => h.trim());
  const records: ExtractedRecord[] = [];

  for (let r = 1; r < rows.length; r++) {
    const cells = rows[r];
    // Skip blank lines (a single empty cell or all-empty cells).
    const isEmpty = cells.every((c) => c.trim().length === 0);
    if (isEmpty) continue;

    const record: ExtractedRecord = {};
    for (let c = 0; c < header.length; c++) {
      const key = header[c];
      if (key.length === 0) continue; // ignore unnamed columns
      record[key] = c < cells.length ? cells[c] : '';
    }
    records.push(record);
  }

  return records;
}

/** Decode CSV content to text whether it arrives as a string or raw bytes. */
function decodeText(content: string | Uint8Array): string {
  if (typeof content === 'string') return content;
  return new TextDecoder('utf-8').decode(content);
}

// ---------------------------------------------------------------------------
// Document_Parser
// ---------------------------------------------------------------------------

/**
 * The Document_Parser. CSV parsing works out of the box; Excel and PDF
 * extraction is delegated to injectable extractors supplied at construction so
 * the core stays dependency-free and testable.
 */
export class DocumentParser {
  private readonly excelExtractor?: ContentExtractor;
  private readonly pdfExtractor?: ContentExtractor;

  constructor(options: DocumentParserOptions = {}) {
    this.excelExtractor = options.excelExtractor;
    this.pdfExtractor = options.pdfExtractor;
  }

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
  parse(file: UploadedFile): Result<ExtractedRecord[], ParseError> {
    // (1) Size guard — checked before parsing so oversize files never load.
    const sizeBytes = fileSizeBytes(file);
    if (sizeBytes > MAX_FILE_SIZE_BYTES) {
      return err({
        kind: 'FILE_TOO_LARGE',
        message: `The uploaded file is ${sizeBytes} bytes, which exceeds the maximum allowed file size of 50 MB (${MAX_FILE_SIZE_BYTES} bytes).`,
        maxBytes: MAX_FILE_SIZE_BYTES,
        actualBytes: sizeBytes,
      });
    }

    // (2) Format detection.
    const format = detectFormat(file);
    if (format === null) {
      return err({
        kind: 'UNSUPPORTED_FORMAT',
        message: `Unsupported file format. The supported formats are ${SUPPORTED_FORMATS.join(', ')}.`,
        supportedFormats: SUPPORTED_FORMATS,
      });
    }

    // (3) Parse / extract per format.
    let records: ExtractedRecord[];
    try {
      records = this.extract(file, format);
    } catch (cause) {
      return err({
        kind: 'PARSE_FAILURE',
        message: `Failed to parse the uploaded ${format} file: ${describeError(cause)}`,
      });
    }

    // (4) Empty extraction.
    if (records.length === 0) {
      return err({
        kind: 'NO_RECORDS',
        message: 'No records were found in the uploaded file.',
      });
    }

    return ok(records);
  }

  /**
   * Dispatch extraction by format. CSV is parsed in-process; Excel and PDF are
   * delegated to their injectable extractor, with a missing extractor surfaced
   * as a parse failure (the format is supported, but unparseable in this
   * configuration) — never an unsupported-format error.
   */
  private extract(
    file: UploadedFile,
    format: SupportedFormat,
  ): ExtractedRecord[] {
    switch (format) {
      case 'CSV': {
        const text = decodeText(file.content);
        return csvRowsToRecords(parseCsv(text));
      }
      case 'EXCEL': {
        if (!this.excelExtractor) {
          throw new Error(
            'no Excel extractor is configured for this Document_Parser',
          );
        }
        return this.excelExtractor(file);
      }
      case 'PDF': {
        if (!this.pdfExtractor) {
          throw new Error(
            'no PDF extractor is configured for this Document_Parser',
          );
        }
        return this.pdfExtractor(file);
      }
    }
  }
}

/** Render an unknown thrown value as a short message for a `PARSE_FAILURE`. */
function describeError(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  if (typeof cause === 'string') return cause;
  return 'unknown parsing error';
}
