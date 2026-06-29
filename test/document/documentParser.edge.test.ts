/**
 * Document_Parser edge-case and extraction-fidelity tests (task 14.6) for the
 * ai-database-architect spec [SECONDARY].
 *
 * Covers the fail-closed error paths of the Document_Parser:
 *  - corrupt / unparseable supported files  -> PARSE_FAILURE   (Req 10.5)
 *  - empty extraction (no records)          -> NO_RECORDS      (Req 10.6)
 *  - oversize files (> 50 MB)               -> FILE_TOO_LARGE  (Req 10.7)
 * plus an example of CSV extraction fidelity (Req 10.1) into named-field
 * records keyed by the header row.
 *
 * Note on timing: Requirement 10.1's "within 30 seconds" extraction budget is
 * an integration-level timing concern for the real Excel/PDF extractors and is
 * not exercised here; these unit tests verify extraction *fidelity* and the
 * structural error taxonomy of the parser itself.
 */

import { describe, it, expect } from 'vitest';

import {
  DocumentParser,
  MAX_FILE_SIZE_BYTES,
  type ContentExtractor,
  type UploadedFile,
} from '../../src/document/documentParser.js';
import { isOk, isErr } from '../../src/model/result.js';

// ---------------------------------------------------------------------------
// Corrupt / unparseable supported files (Req 10.5)
// ---------------------------------------------------------------------------

describe('Document_Parser: corrupt/unparseable files (Req 10.5)', () => {
  it('reports PARSE_FAILURE for an Excel file when no Excel extractor is configured', () => {
    const parser = new DocumentParser(); // no extractors configured
    const file: UploadedFile = {
      name: 'workbook.xlsx',
      format: 'xlsx',
      content: new Uint8Array([0x50, 0x4b, 0x03, 0x04]), // ZIP/xlsx magic bytes
    };
    const result = parser.parse(file);
    expect(isErr(result)).toBe(true);
    if (isErr(result)) {
      expect(result.error.kind).toBe('PARSE_FAILURE');
    }
    // Fail closed: no partial records.
    expect('value' in result).toBe(false);
  });

  it('reports PARSE_FAILURE for a PDF file when no PDF extractor is configured', () => {
    const parser = new DocumentParser();
    const file: UploadedFile = {
      name: 'doc.pdf',
      format: 'pdf',
      content: '%PDF-1.7 not-really-a-pdf',
    };
    const result = parser.parse(file);
    expect(isErr(result)).toBe(true);
    if (isErr(result)) {
      expect(result.error.kind).toBe('PARSE_FAILURE');
    }
    expect('value' in result).toBe(false);
  });

  it('reports PARSE_FAILURE when a configured extractor throws on corrupt content', () => {
    const throwingExtractor: ContentExtractor = () => {
      throw new Error('corrupt workbook: unexpected end of central directory');
    };
    const parser = new DocumentParser({ excelExtractor: throwingExtractor });
    const file: UploadedFile = {
      name: 'broken.xlsx',
      format: 'xlsx',
      content: new Uint8Array([0x00, 0x01, 0x02]),
    };
    const result = parser.parse(file);
    expect(isErr(result)).toBe(true);
    if (isErr(result)) {
      expect(result.error.kind).toBe('PARSE_FAILURE');
      // The underlying cause is surfaced in the message.
      expect(result.error.message).toContain('corrupt workbook');
    }
    expect('value' in result).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Empty extraction (Req 10.6)
// ---------------------------------------------------------------------------

describe('Document_Parser: empty extractions (Req 10.6)', () => {
  it('reports NO_RECORDS for a header-only CSV', () => {
    const parser = new DocumentParser();
    const file: UploadedFile = {
      name: 'people.csv',
      content: 'name,dept\n', // header row only, no data rows
    };
    const result = parser.parse(file);
    expect(isErr(result)).toBe(true);
    if (isErr(result)) {
      expect(result.error.kind).toBe('NO_RECORDS');
    }
    expect('value' in result).toBe(false);
  });

  it('reports NO_RECORDS for completely empty CSV content', () => {
    const parser = new DocumentParser();
    const file: UploadedFile = { name: 'empty.csv', content: '' };
    const result = parser.parse(file);
    expect(isErr(result)).toBe(true);
    if (isErr(result)) {
      expect(result.error.kind).toBe('NO_RECORDS');
    }
    expect('value' in result).toBe(false);
  });

  it('reports NO_RECORDS when a configured extractor yields zero records', () => {
    const emptyExtractor: ContentExtractor = () => [];
    const parser = new DocumentParser({ pdfExtractor: emptyExtractor });
    const file: UploadedFile = {
      name: 'blank.pdf',
      format: 'pdf',
      content: '%PDF-1.7',
    };
    const result = parser.parse(file);
    expect(isErr(result)).toBe(true);
    if (isErr(result)) {
      expect(result.error.kind).toBe('NO_RECORDS');
    }
    expect('value' in result).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Oversize files (Req 10.7)
// ---------------------------------------------------------------------------

describe('Document_Parser: oversize files (Req 10.7)', () => {
  it('reports FILE_TOO_LARGE for a file just above the 50 MB limit', () => {
    const parser = new DocumentParser();
    const actualBytes = MAX_FILE_SIZE_BYTES + 1;
    const file: UploadedFile = {
      name: 'huge.csv',
      // Declared size is authoritative; content stays tiny so the test is fast.
      size: actualBytes,
      content: 'name,dept\nAlice,Engineering\n',
    };
    const result = parser.parse(file);
    expect(isErr(result)).toBe(true);
    if (isErr(result)) {
      expect(result.error.kind).toBe('FILE_TOO_LARGE');
      if (result.error.kind === 'FILE_TOO_LARGE') {
        expect(result.error.maxBytes).toBe(MAX_FILE_SIZE_BYTES);
        expect(result.error.actualBytes).toBe(actualBytes);
      }
    }
    // Oversize files are rejected before any parsing; no records retained.
    expect('value' in result).toBe(false);
  });

  it('accepts a file exactly at the 50 MB boundary (size check is strict >)', () => {
    const parser = new DocumentParser();
    const file: UploadedFile = {
      name: 'atlimit.csv',
      size: MAX_FILE_SIZE_BYTES,
      content: 'name,dept\nAlice,Engineering\n',
    };
    const result = parser.parse(file);
    expect(isOk(result)).toBe(true);
    if (isOk(result)) {
      expect(result.value).toHaveLength(1);
    }
  });
});

// ---------------------------------------------------------------------------
// CSV extraction fidelity (Req 10.1)
// ---------------------------------------------------------------------------

describe('Document_Parser: CSV extraction fidelity (Req 10.1)', () => {
  it('extracts named-field records keyed by the header, honoring quoting and embedded commas', () => {
    const parser = new DocumentParser();
    const csv = [
      'name,role,city',
      '"Doe, Jane",Engineer,Seattle',
      'Bob,"Sales, Lead","Portland, OR"',
    ].join('\n');
    const file: UploadedFile = { name: 'staff.csv', content: csv };

    const result = parser.parse(file);
    expect(isOk(result)).toBe(true);
    if (isOk(result)) {
      expect(result.value).toEqual([
        { name: 'Doe, Jane', role: 'Engineer', city: 'Seattle' },
        { name: 'Bob', role: 'Sales, Lead', city: 'Portland, OR' },
      ]);
    }
  });

  it('detects CSV from the text/csv content type and preserves embedded quotes', () => {
    const parser = new DocumentParser();
    const csv = 'product,note\nWidget,"He said ""hi"" today"\n';
    const file: UploadedFile = {
      name: 'inventory', // no extension; format detected via content type
      contentType: 'text/csv',
      content: csv,
    };

    const result = parser.parse(file);
    expect(isOk(result)).toBe(true);
    if (isOk(result)) {
      expect(result.value).toEqual([
        { product: 'Widget', note: 'He said "hi" today' },
      ]);
    }
  });
});
