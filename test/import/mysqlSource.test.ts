/**
 * Offline test for the pure MySQL information_schema → SourceSchema mapping
 * (src/import/mysqlSource.ts `buildMysqlSourceSchema`). Confirms columns, PKs,
 * FKs, unique flags, and grouped indexes assemble correctly and import into a
 * well-formed Data_Model.
 */

import { describe, it, expect } from 'vitest';
import { buildMysqlSourceSchema } from '../../src/import/mysqlSource.js';
import { SourceImportAnalyzer } from '../../src/import/importAnalyzer.js';
import { InMemorySource } from '../../src/import/inMemorySource.js';
import { isOk, unwrap } from '../../src/model/result.js';
import { validateDataModel } from '../../src/model/invariants.js';

const ROWS = {
  columns: [
    { TABLE_NAME: 'customers', COLUMN_NAME: 'id', DATA_TYPE: 'int', IS_NULLABLE: 'NO', COLUMN_KEY: 'PRI' },
    { TABLE_NAME: 'customers', COLUMN_NAME: 'email', DATA_TYPE: 'varchar', IS_NULLABLE: 'NO', COLUMN_KEY: 'UNI' },
    { TABLE_NAME: 'orders', COLUMN_NAME: 'id', DATA_TYPE: 'int', IS_NULLABLE: 'NO', COLUMN_KEY: 'PRI' },
    { TABLE_NAME: 'orders', COLUMN_NAME: 'customer_id', DATA_TYPE: 'int', IS_NULLABLE: 'YES', COLUMN_KEY: 'MUL' },
  ],
  primaryKeys: [
    { TABLE_NAME: 'customers', COLUMN_NAME: 'id' },
    { TABLE_NAME: 'orders', COLUMN_NAME: 'id' },
  ],
  foreignKeys: [
    { TABLE_NAME: 'orders', COLUMN_NAME: 'customer_id', REFERENCED_TABLE_NAME: 'customers', REFERENCED_COLUMN_NAME: 'id' },
  ],
  indexes: [
    { TABLE_NAME: 'orders', INDEX_NAME: 'idx_cust', COLUMN_NAME: 'customer_id', NON_UNIQUE: 1 },
    { TABLE_NAME: 'customers', INDEX_NAME: 'uq_email', COLUMN_NAME: 'email', NON_UNIQUE: 0 },
  ],
};

describe('buildMysqlSourceSchema', () => {
  it('maps columns, primary keys, foreign keys, unique flags, and indexes', () => {
    const schema = buildMysqlSourceSchema(ROWS);
    const byName = new Map(schema.tables.map((t) => [t.name, t]));

    const customers = byName.get('customers')!;
    expect(customers.primaryKey).toEqual(['id']);
    expect(customers.columns.find((c) => c.name === 'email')!.unique).toBe(true);

    const orders = byName.get('orders')!;
    expect(orders.foreignKeys).toEqual([
      { column: 'customer_id', referencesTable: 'customers', referencesColumn: 'id' },
    ]);
    const idx = orders.indexes.find((i) => i.name === 'idx_cust')!;
    expect(idx.unique).toBe(false);
    expect(idx.columns).toEqual(['customer_id']);
  });

  it('imports through the analyzer into a well-formed Data_Model', async () => {
    const schema = buildMysqlSourceSchema(ROWS);
    const analyzer = new SourceImportAnalyzer(new InMemorySource({ schema }));
    const result = await analyzer.importSchema({
      host: 'h', port: 3306, database: 'shop', user: 'u', password: 'p',
    });
    expect(isOk(result)).toBe(true);
    const { model } = unwrap(result);
    expect(isOk(validateDataModel(model))).toBe(true);
    expect(model.entities.map((e) => e.name).sort()).toEqual(['customers', 'orders']);
  });
});
