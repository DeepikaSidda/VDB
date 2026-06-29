/**
 * Tests for the Document-to-Backend *data seeding* path (Req 10): a document
 * upload should not only derive a relational schema, but also load the
 * document's actual rows into the generated backend so the Admin_Dashboard and
 * CRUD API serve real data.
 *
 * Two levels are covered:
 *  - `inferModelAndSeedFromRecords` — the deterministic decomposition produces
 *    distinct group rows, one main row per source record, and foreign keys that
 *    correctly link each main row to its group row.
 *  - The full {@link GenerationPipeline} — a DOCUMENT (CSV) input runs end to
 *    end and the resulting backend's CRUD store actually contains the seeded
 *    rows (the bug the user hit: "No records match").
 */

import { describe, it, expect } from 'vitest';

import { inferModelAndSeedFromRecords } from '../../src/modeling/records.js';
import { GenerationPipeline } from '../../src/pipeline/pipeline.js';
import { isOk, unwrap } from '../../src/model/result.js';
import type { Entity } from '../../src/model/types.js';

/** The student-attendance sample, mirrored as extracted records. */
const ATTENDANCE_RECORDS = [
  { rollNo: '101', studentName: 'Ann Sharma', branch: 'CSE', facultyName: 'Dr. Smith', facultyDept: 'Computer Science', classDate: '2024-01-10', present: 'true' },
  { rollNo: '102', studentName: 'Bob Verma', branch: 'CSE', facultyName: 'Dr. Smith', facultyDept: 'Computer Science', classDate: '2024-01-10', present: 'false' },
  { rollNo: '103', studentName: 'Cara Iyer', branch: 'ECE', facultyName: 'Dr. Lee', facultyDept: 'Electronics', classDate: '2024-01-10', present: 'true' },
  { rollNo: '104', studentName: 'Dev Rao', branch: 'ECE', facultyName: 'Dr. Lee', facultyDept: 'Electronics', classDate: '2024-01-11', present: 'true' },
  { rollNo: '105', studentName: 'Esha Nair', branch: 'CSE', facultyName: 'Dr. Smith', facultyDept: 'Computer Science', classDate: '2024-01-11', present: 'true' },
  { rollNo: '106', studentName: 'Farhan Ali', branch: 'ME', facultyName: 'Dr. Patel', facultyDept: 'Mechanical', classDate: '2024-01-11', present: 'false' },
  { rollNo: '107', studentName: 'Gita Bose', branch: 'ME', facultyName: 'Dr. Patel', facultyDept: 'Mechanical', classDate: '2024-01-12', present: 'true' },
  { rollNo: '108', studentName: 'Hari Menon', branch: 'ECE', facultyName: 'Dr. Lee', facultyDept: 'Electronics', classDate: '2024-01-12', present: 'true' },
];

const ATTENDANCE_CSV = [
  'rollNo,studentName,branch,facultyName,facultyDept,classDate,present',
  ...ATTENDANCE_RECORDS.map((r) =>
    [r.rollNo, r.studentName, r.branch, r.facultyName, r.facultyDept, r.classDate, r.present].join(','),
  ),
].join('\n');

/** The first entity that carries every one of `attrNames`. */
function entityWith(
  entities: readonly Entity[],
  attrNames: readonly string[],
): Entity | undefined {
  return entities.find((e) => {
    const names = new Set(e.attributes.map((a) => a.name));
    return attrNames.every((n) => names.has(n));
  });
}

describe('Document seeding — inferModelAndSeedFromRecords', () => {
  it('produces one main row per source record and distinct group rows linked by FK', () => {
    const result = inferModelAndSeedFromRecords(ATTENDANCE_RECORDS);
    expect(isOk(result)).toBe(true);
    const { model, seed } = unwrap(result);

    const mainEntity = entityWith(model.entities, ['rollNo', 'studentName']);
    const facultyEntity = entityWith(model.entities, ['facultyName', 'facultyDept']);
    expect(mainEntity).toBeDefined();
    expect(facultyEntity).toBeDefined();

    // One main row per source record.
    const mainRows = seed.get(mainEntity!.name) ?? [];
    expect(mainRows).toHaveLength(ATTENDANCE_RECORDS.length);

    // The faculty group repeats: 3 distinct {name, dept} combinations.
    const facultyRows = seed.get(facultyEntity!.name) ?? [];
    expect(facultyRows).toHaveLength(3);

    // Every faculty row has a unique surrogate id.
    const facultyPk = facultyEntity!.primaryKey[0];
    const facultyIds = new Set(facultyRows.map((r) => r[facultyPk]));
    expect(facultyIds.size).toBe(3);

    // The FK column on the main entity referencing the faculty entity.
    const fkAttr = mainEntity!.attributes.find((a) =>
      a.constraints.some(
        (c) => c.kind === 'FOREIGN_KEY' && c.references.entity === facultyEntity!.name,
      ),
    );
    expect(fkAttr).toBeDefined();

    // Each main row's FK points at an existing faculty row, and matches the
    // faculty values of the corresponding source record.
    const facultyById = new Map(facultyRows.map((r) => [r[facultyPk], r]));
    mainRows.forEach((row, i) => {
      const fkValue = row[fkAttr!.name];
      expect(facultyIds.has(fkValue)).toBe(true);
      const linked = facultyById.get(fkValue)!;
      expect(linked.facultyName).toBe(ATTENDANCE_RECORDS[i].facultyName);
      expect(linked.facultyDept).toBe(ATTENDANCE_RECORDS[i].facultyDept);
    });
  });
});

describe('Document seeding — full GenerationPipeline (CSV upload)', () => {
  it('deploys and the live backend serves the uploaded rows', async () => {
    const pipeline = new GenerationPipeline();
    const { job, backend } = await pipeline.run({
      kind: 'DOCUMENT',
      document: { name: 'student-attendance.csv', content: ATTENDANCE_CSV, encoding: 'utf8' },
    });

    expect(job.status).toBe('deployed');
    expect(backend).toBeDefined();

    const mainEntity = entityWith(backend!.model.entities, ['rollNo', 'studentName']);
    expect(mainEntity).toBeDefined();

    // The CRUD runtime actually serves the seeded rows (not "No records").
    const mainCrud = backend!.crud.get(mainEntity!.name);
    expect(mainCrud).toBeDefined();
    const listed = mainCrud!.list({ size: 100 });
    expect(isOk(listed)).toBe(true);
    expect(unwrap(listed).total).toBe(ATTENDANCE_RECORDS.length);

    // The faculty group entity is seeded with its distinct instances.
    const facultyEntity = entityWith(backend!.model.entities, ['facultyName', 'facultyDept']);
    expect(facultyEntity).toBeDefined();
    const facultyList = backend!.crud.get(facultyEntity!.name)!.list({ size: 100 });
    expect(unwrap(facultyList).total).toBe(3);
  });
});
