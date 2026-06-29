/**
 * Unit tests for the pure introspection-row → SourceSchema assembly used by the
 * real PgSource adapter (src/import/pgSource.ts `buildSourceSchema`).
 *
 * These run offline: they feed representative `information_schema` / `pg_indexes`
 * rows and assert the assembled SourceSchema (columns, PKs, FKs, unique flags,
 * indexes) is shaped correctly, then confirm the result imports through the
 * Import_Analyzer into a well-formed Data_Model.
 */

import { describe, it, expect } from 'vitest';
import { buildSourceSchema } from '../../src/import/pgSource.js';
import { SourceImportAnalyzer } from '../../src/import/importAnalyzer.js';
import { InMemorySource } from '../../src/import/inMemorySource.js';
import { isOk, unwrap } from '../../src/model/result.js';
import { validateDataModel } from '../../src/model/invariants.js';

const ROWS = {
  columns: [
    { table_name: 'customer', column_name: 'id', data_type: 'uuid', is_nullable: 'NO' },
    { table_name: 'customer', column_name: 'email', data_type: 'character varying', is_nullable: 'NO' },
    { table_name: 'order', column_name: 'id', data_type: 'uuid', is_nullable: 'NO' },
    { table_name: 'order', column_name: 'customer_id', data_type: 'uuid', is_nullable: 'YES' },
  ],
  primaryKeys: [
    { table_name: 'customer', column_name: 'id' },
    { table_name: 'order', column_name: 'id' },
  ],
  foreignKeys: [
    { table_name: 'order', column_name: 'customer_id', references_table: 'customer', references_column: 'id' },
  ],
  uniques: [{ table_name: 'customer', column_name: 'email' }],
  indexes: [
    { table_name: 'order', index_name: 'idx_order_customer', indexdef: 'CREATE INDEX idx_order_customer ON public."order" (customer_id)' },
    { table_name: 'customer', index_name: 'uq_customer_email', indexdef: 'CREATE UNIQUE INDEX uq_customer_email ON public.customer (email)' },
  ],
};

describe('buildSourceSchema', () => {
  it('assembles tables with columns, primary keys, foreign keys, and unique flags', () => {
    const schema = buildSourceSchema(ROWS);
    const byName = new Map(schema.tables.map((t) => [t.name, t]));

    const customer = byName.get('customer')!;
    expect(customer.primaryKey).toEqual(['id']);
    expect(customer.columns.map((c) => c.name)).toEqual(['id', 'email']);
    const email = customer.columns.find((c) => c.name === 'email')!;
    expect(email.unique).toBe(true);
    expect(email.nullable).toBe(false);

    const order = byName.get('order')!;
    expect(order.foreignKeys).toEqual([
      { column: 'customer_id', referencesTable: 'customer', referencesColumn: 'id' },
    ]);
    const customerId = order.columns.find((c) => c.name === 'customer_id')!;
    expect(customerId.nullable).toBe(true);
  });

  it('parses index columns and unique-ness from the index definition', () => {
    const schema = buildSourceSchema(ROWS);
    const customer = schema.tables.find((t) => t.name === 'customer')!;
    const uq = customer.indexes.find((i) => i.name === 'uq_customer_email')!;
    expect(uq.columns).toEqual(['email']);
    expect(uq.unique).toBe(true);

    const order = schema.tables.find((t) => t.name === 'order')!;
    const idx = order.indexes.find((i) => i.name === 'idx_order_customer')!;
    expect(idx.unique).toBe(false);
    expect(idx.columns).toEqual(['customer_id']);
  });

  it('imports through the analyzer into a well-formed Data_Model', async () => {
    const schema = buildSourceSchema(ROWS);
    const analyzer = new SourceImportAnalyzer(new InMemorySource({ schema }));
    const result = await analyzer.importSchema({
      host: 'h',
      port: 5432,
      database: 'd',
      user: 'u',
      password: 'p',
    });
    expect(isOk(result)).toBe(true);
    const { model } = unwrap(result);
    expect(isOk(validateDataModel(model))).toBe(true);
    expect(model.entities.map((e) => e.name).sort()).toEqual(['customer', 'order']);
  });
});
