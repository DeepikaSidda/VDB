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

import * as XLSX from 'xlsx';
import type {
  ContentExtractor,
  ExtractedRecord,
  UploadedFile,
} from './documentParser.js';

// ---------------------------------------------------------------------------
// Excel (synchronous — usable as a DocumentParser extractor)
// ---------------------------------------------------------------------------

/** Coerce the uploaded content into a form SheetJS can read. */
function toWorkbookInput(content: string | Uint8Array): {
  data: Uint8Array | string;
  type: 'array' | 'base64' | 'binary';
} {
  if (typeof content === 'string') {
    // Heuristic: a base64 string vs raw binary string. Treat as base64.
    return { data: content, type: 'base64' };
  }
  return { data: content, type: 'array' };
}

/**
 * Extract records from an Excel workbook's first sheet (Requirement 10.1).
 * Header row → field names; following rows → records keyed by header.
 */
export const xlsxExtractor: ContentExtractor = (
  file: UploadedFile,
): ExtractedRecord[] => {
  const input = toWorkbookInput(file.content);
  const workbook = XLSX.read(input.data, { type: input.type });
  const firstSheetName = workbook.SheetNames[0];
  if (firstSheetName === undefined) {
    return [];
  }
  const sheet = workbook.Sheets[firstSheetName];
  // `defval: null` keeps empty cells present; rows become {header: value} maps.
  const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, {
    defval: null,
    raw: true,
  });
  return rows;
};

/** One worksheet's extracted records, tagged with the sheet (table) name. */
export type SheetRecords = { name: string; records: ExtractedRecord[] };

/**
 * Extract records from EVERY non-empty worksheet of a workbook (Requirement
 * 10.1, multi-sheet extension). Each sheet becomes a candidate table: the
 * pipeline maps each to its own entity and infers relationships between them by
 * foreign-key naming. Sheets with no data rows are dropped. Sheet names are
 * trimmed; empty/duplicate names are disambiguated so each entity is distinct.
 */
export function xlsxSheets(file: UploadedFile): SheetRecords[] {
  const input = toWorkbookInput(file.content);
  const workbook = XLSX.read(input.data, { type: input.type });
  const out: SheetRecords[] = [];
  const taken = new Set<string>();
  for (const rawName of workbook.SheetNames) {
    const sheet = workbook.Sheets[rawName];
    if (sheet === undefined) {
      continue;
    }
    const records = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, {
      defval: null,
      raw: true,
    });
    if (records.length === 0) {
      continue;
    }
    let name = (rawName ?? '').trim() || 'Sheet';
    if (taken.has(name)) {
      let i = 2;
      while (taken.has(`${name}_${i}`)) i += 1;
      name = `${name}_${i}`;
    }
    taken.add(name);
    out.push({ name, records });
  }
  return out;
}

// ---------------------------------------------------------------------------
// PDF (asynchronous — used by the pipeline document path)
// ---------------------------------------------------------------------------

/** Minimal shape of the `pdf-parse` v2 API we rely on. */
type PdfParseV2 = {
  PDFParse: new (opts: { data: Buffer }) => {
    getText(): Promise<{ text: string }>;
    getTable(): Promise<{
      mergedTables?: string[][][];
      pages?: { tables?: string[][][] }[];
    }>;
    destroy(): Promise<void>;
  };
};

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
export async function extractPdfRecords(
  bytes: Uint8Array,
): Promise<ExtractedRecord[]> {
  const mod = (await import('pdf-parse')) as unknown as PdfParseV2;
  const parser = new mod.PDFParse({ data: Buffer.from(bytes) });
  try {
    // 1) Structured tables — the most reliable for real tabular PDFs.
    try {
      const tables = await parser.getTable();
      const candidates: string[][][] = [
        ...(tables.mergedTables ?? []),
        ...((tables.pages ?? []).flatMap((p) => p.tables ?? [])),
      ];
      for (const table of candidates) {
        const records = tableToRecords(table);
        if (records.length > 0) {
          return records;
        }
      }
    } catch {
      // Table extraction unavailable for this PDF; fall back to text.
    }

    // 2) Text-layer heuristic fallback.
    const result = await parser.getText();
    return pdfTextToRecords(result.text);
  } finally {
    await parser.destroy().catch(() => undefined);
  }
}

/**
 * Convert one extracted table (rows of string cells) into records: the first
 * non-empty row is the header, each following row a record keyed by it. Rows
 * whose length doesn't match the header are skipped. Returns `[]` for a table
 * with fewer than two rows or fewer than two columns.
 */
export function tableToRecords(table: readonly string[][]): ExtractedRecord[] {
  const rows = table.filter((r) => r.some((c) => String(c ?? '').trim().length > 0));
  if (rows.length < 2) {
    return [];
  }
  const header = rows[0].map((h) => String(h ?? '').trim());
  if (header.filter((h) => h.length > 0).length < 2) {
    return [];
  }
  const records: ExtractedRecord[] = [];
  for (let i = 1; i < rows.length; i++) {
    const cells = rows[i];
    if (cells.length !== header.length) {
      continue;
    }
    const record: ExtractedRecord = {};
    header.forEach((key, idx) => {
      if (key.length > 0) {
        record[key] = String(cells[idx] ?? '').trim();
      }
    });
    records.push(record);
  }
  return records;
}

/**
 * Parse plain text extracted from a PDF into records. Splits into non-empty
 * lines, infers a delimiter (comma, tab, pipe, or runs of 2+ spaces), and uses
 * the first line as the header. Lines whose column count doesn't match the
 * header are skipped. Returns `[]` if fewer than two usable lines exist.
 */
export function pdfTextToRecords(text: string): ExtractedRecord[] {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  if (lines.length < 2) {
    return [];
  }

  const splitter = pickDelimiter(lines[0]);
  const header = splitter(lines[0]).map((h) => h.trim());
  if (header.length < 2) {
    return [];
  }

  const records: ExtractedRecord[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = splitter(lines[i]).map((c) => c.trim());
    if (cells.length !== header.length) {
      continue;
    }
    const record: ExtractedRecord = {};
    header.forEach((key, idx) => {
      if (key.length > 0) {
        record[key] = cells[idx];
      }
    });
    records.push(record);
  }
  return records;
}

/** Choose a splitter function based on the delimiter present in a sample line. */
function pickDelimiter(sample: string): (line: string) => string[] {
  if (sample.includes('\t')) {
    return (line) => line.split('\t');
  }
  if (sample.includes('|')) {
    return (line) => line.split('|');
  }
  if (sample.includes(',')) {
    return (line) => line.split(',');
  }
  // Fall back to runs of two-or-more spaces (common in PDF text columns).
  return (line) => line.split(/\s{2,}/);
}
