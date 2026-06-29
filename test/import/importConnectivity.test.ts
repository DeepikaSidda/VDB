/**
 * Tests for import connectivity and unsupported targets (task 15.6) [STRETCH].
 *
 * Feature: ai-database-architect
 *
 * Covers:
 * - Import connect/extract and the timeout-vs-authentication-failure
 *   distinction (Req 11.1, 11.5), plus the happy import path with a
 *   not-extracted unsupported source column type (Req 11.2).
 * - The unsupported-target validation path of the Schema_Generator
 *   (Req 13.4): an unsupported target fails closed, names the supported
 *   targets, and emits no output.
 */

import { describe, it, expect } from 'vitest';
import type { DbCredentials, DataModel, DeploymentTargetKind } from '../../src/model/types.js';
import { isErr, isOk, unwrap } from '../../src/model/result.js';
import { SourceImportAnalyzer } from '../../src/import/importAnalyzer.js';
import { InMemorySource, MutableClock } from '../../src/import/inMemorySource.js';
import { CONNECT_TIMEOUT_MS, type SourceSchema } from '../../src/import/sourceDriver.js';
import { generate, SUPPORTED_TARGETS } from '../../src/schema/schemaGenerator.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const CREDS: DbCredentials = {
  host: 'db.example.com',
  port: 5432,
  database: 'legacy',
  user: 'reader',
  password: 'secret',
};

const SMALL_SCHEMA: SourceSchema = {
  tables: [
    {
      name: 'customer',
      columns: [
        { name: 'id', sourceType: 'uuid', nullable: false, unique: false },
        { name: 'name', sourceType: 'varchar(255)', nullable: false, unique: false },
        // An unsupported source dialect type -> recorded as not-extracted (Req 11.2).
        { name: 'location', sourceType: 'geometry', nullable: true, unique: false },
      ],
      primaryKey: ['id'],
      foreignKeys: [],
      indexes: [],
    },
  ],
};

// ---------------------------------------------------------------------------
// Connectivity: timeout vs authentication failure (Req 11.1, 11.5)
// ---------------------------------------------------------------------------

describe('Import connectivity — timeout vs authentication failure (Req 11.1, 11.5)', () => {
  it('an unreachable source yields CONNECTION_TIMEOUT', async () => {
    const analyzer = new SourceImportAnalyzer(new InMemorySource({ reachable: false }));
    const result = await analyzer.importSchema(CREDS);
    expect(isErr(result)).toBe(true);
    if (isErr(result)) {
      expect(result.error.kind).toBe('CONNECTION_TIMEOUT');
    }
  });

  it('rejected credentials yield AUTHENTICATION_FAILURE', async () => {
    const analyzer = new SourceImportAnalyzer(new InMemorySource({ authenticates: false }));
    const result = await analyzer.importSchema(CREDS);
    expect(isErr(result)).toBe(true);
    if (isErr(result)) {
      expect(result.error.kind).toBe('AUTHENTICATION_FAILURE');
    }
  });

  it('a connect exceeding the 30s window yields CONNECTION_TIMEOUT (shared clock)', async () => {
    const clock = new MutableClock();
    const source = new InMemorySource({
      clock,
      connectDurationMs: CONNECT_TIMEOUT_MS + 1,
    });
    const analyzer = new SourceImportAnalyzer(source, clock);
    const result = await analyzer.importSchema(CREDS);
    expect(isErr(result)).toBe(true);
    if (isErr(result)) {
      expect(result.error.kind).toBe('CONNECTION_TIMEOUT');
    }
  });

  it('distinguishes the two failure modes (they are not the same error kind)', async () => {
    const timeout = await new SourceImportAnalyzer(
      new InMemorySource({ reachable: false }),
    ).importSchema(CREDS);
    const auth = await new SourceImportAnalyzer(
      new InMemorySource({ authenticates: false }),
    ).importSchema(CREDS);

    expect(isErr(timeout) && isErr(auth)).toBe(true);
    if (isErr(timeout) && isErr(auth)) {
      expect(timeout.error.kind).toBe('CONNECTION_TIMEOUT');
      expect(auth.error.kind).toBe('AUTHENTICATION_FAILURE');
      expect(timeout.error.kind).not.toBe(auth.error.kind);
    }
  });
});

// ---------------------------------------------------------------------------
// Happy import path with a not-extracted column (Req 11.1, 11.2)
// ---------------------------------------------------------------------------

describe('Import extraction — happy path with not-extracted indicators (Req 11.1, 11.2)', () => {
  it('imports a small schema into the expected entities', async () => {
    const analyzer = new SourceImportAnalyzer(new InMemorySource({ schema: SMALL_SCHEMA }));
    const result = await analyzer.importSchema(CREDS);
    expect(isOk(result)).toBe(true);

    const { model } = unwrap(result);
    expect(model.entities.map((e) => e.name)).toEqual(['customer']);
    const customer = model.entities[0];
    expect(customer.primaryKey).toEqual(['id']);
    expect(customer.attributes.map((a) => a.name)).toEqual(['id', 'name', 'location']);
  });

  it('records an unsupported source column type as not-extracted and continues', async () => {
    const analyzer = new SourceImportAnalyzer(new InMemorySource({ schema: SMALL_SCHEMA }));
    const { notExtracted, model } = unwrap(await analyzer.importSchema(CREDS));

    // The geometry column could not be mapped -> recorded, extraction continued.
    expect(notExtracted).toHaveLength(1);
    expect(notExtracted[0]).toMatchObject({
      element: 'COLUMN_TYPE',
      table: 'customer',
      column: 'location',
    });

    // Extraction continued: the supported columns are still present, and the
    // not-extracted column is flagged for review in the model.
    const location = model.entities[0].attributes.find((a) => a.name === 'location');
    expect(location?.needsReview).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Unsupported-target validation path (Req 13.4)
// ---------------------------------------------------------------------------

describe('Schema_Generator — unsupported target fails closed (Req 13.4)', () => {
  const model: DataModel = {
    entities: [
      {
        name: 'widget',
        attributes: [{ name: 'id', dataType: 'UUID', constraints: [{ kind: 'PRIMARY_KEY' }] }],
        primaryKey: ['id'],
        isJoinEntity: false,
      },
    ],
    relationships: [],
  };

  it('rejects an unsupported target with UNSUPPORTED_TARGET, lists supported targets, emits no output', () => {
    const result = generate(model, 'MONGODB' as unknown as DeploymentTargetKind);
    expect(isErr(result)).toBe(true);
    if (isErr(result)) {
      expect(result.error.kind).toBe('UNSUPPORTED_TARGET');
      if (result.error.kind === 'UNSUPPORTED_TARGET') {
        expect(result.error.target).toBe('MONGODB');
        expect(result.error.supportedTargets).toEqual([...SUPPORTED_TARGETS]);
      }
    }
    // Fail closed: no MigrationScript / DDL is produced on the error branch.
    expect(isOk(result)).toBe(false);
  });

  it('each supported target still generates successfully', () => {
    for (const target of SUPPORTED_TARGETS) {
      expect(isOk(generate(model, target))).toBe(true);
    }
  });
});
