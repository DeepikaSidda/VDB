/**
 * Offline tests for the Excel/PDF extractors (src/document/extractors.ts).
 * Excel is tested by round-tripping a workbook built in-memory with SheetJS;
 * PDF text parsing is tested via the pure `pdfTextToRecords` helper.
 */

import { describe, it, expect } from 'vitest';
import * as XLSX from 'xlsx';
import { xlsxExtractor, pdfTextToRecords } from '../../src/document/extractors.js';

describe('xlsxExtractor', () => {
  it('extracts header-keyed records from the first worksheet', () => {
    const rows = [
      { name: 'Ann', dept: 'Biology' },
      { name: 'Bob', dept: 'Physics' },
    ];
    const ws = XLSX.utils.json_to_sheet(rows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
    const buf = XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer;

    const records = xlsxExtractor({
      name: 'people.xlsx',
      format: 'xlsx',
      content: new Uint8Array(buf),
    });

    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({ name: 'Ann', dept: 'Biology' });
    expect(records[1]).toMatchObject({ name: 'Bob', dept: 'Physics' });
  });
});

describe('pdfTextToRecords', () => {
  it('parses a comma-delimited text table into records', () => {
    const text = 'name,amount\nWidget,10\nGadget,20\n';
    const records = pdfTextToRecords(text);
    expect(records).toEqual([
      { name: 'Widget', amount: '10' },
      { name: 'Gadget', amount: '20' },
    ]);
  });

  it('parses a whitespace-aligned text table', () => {
    const text = 'sku    qty\nABC    3\nDEF    7';
    const records = pdfTextToRecords(text);
    expect(records).toEqual([
      { sku: 'ABC', qty: '3' },
      { sku: 'DEF', qty: '7' },
    ]);
  });

  it('returns [] when there is no tabular structure', () => {
    expect(pdfTextToRecords('just one line')).toEqual([]);
    expect(pdfTextToRecords('')).toEqual([]);
  });
});
