/**
 * Live PostgreSQL-backed CRUD for a deployed generation.
 *
 * When a generation deployed to a real Aurora/RDS Postgres target, its data
 * lives in a dedicated schema (`gen_<id>`). This module runs the dashboard's
 * list / search / filter / create / update / delete operations as real SQL
 * against that schema, so the admin UI reflects — and mutates — the actual
 * database rather than an in-memory copy.
 *
 * Connection details are read from the same `AIDA_DB_*` environment the
 * pipeline uses; a single pooled client is reused across requests. The `pg`
 * module is imported lazily so this file is safe to load even in a pure
 * in-memory configuration.
 *
 * Constraint handling: NOT NULL / UNIQUE / PRIMARY KEY / FOREIGN KEY are
 * enforced by the database (violations are mapped to friendly 400s); EMAIL and
 * numeric RANGE are validated in JS up-front (the engine's rules) so the user
 * gets a clear message before the row is sent.
 */

import { randomUUID } from 'node:crypto';
import type { Attribute, DataModel, DataType, Entity } from '../../dist/src/model/types.js';
import type { EntityRecord } from '../../dist/src/api/crudRuntime.js';
import type { FilterOperator, QueryResult } from '../../dist/src/dashboard/query.js';
import { isValidEmail } from '../../dist/src/modeling/constraints.js';
import type { CrudOutcome, ListParams } from './crud';

// ---------------------------------------------------------------------------
// Pooled connection (one per server process)
// ---------------------------------------------------------------------------

interface PgPoolLike {
  query(sql: string, values?: unknown[]): Promise<{ rows: any[]; rowCount: number | null }>;
}

async function getPool(): Promise<PgPoolLike> {
  const g = globalThis as unknown as { __aidaPgPool?: PgPoolLike };
  if (g.__aidaPgPool) {
    return g.__aidaPgPool;
  }
  const pg = (await import('pg')) as unknown as {
    Pool: new (config: Record<string, unknown>) => PgPoolLike;
  };
  const pool = new pg.Pool({
    host: process.env.AIDA_DB_HOST,
    port: Number(process.env.AIDA_DB_PORT ?? 5432),
    database: process.env.AIDA_DB_NAME,
    user: process.env.AIDA_DB_USER,
    password: process.env.AIDA_DB_PASSWORD,
    ssl: { rejectUnauthorized: false },
    max: 4,
  });
  g.__aidaPgPool = pool;
  return pool;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/** Fully-qualified, quoted `"schema"."Entity"`. */
function qualified(schema: string, entity: string): string {
  return `${quoteIdent(schema)}.${quoteIdent(entity)}`;
}

function entityOf(model: DataModel, name: string): Entity | undefined {
  return model.entities.find((e) => e.name === name);
}

/** Coerce an incoming value to the column's declared type for the DB. */
function coerce(value: unknown, dataType: DataType): unknown {
  if (value === undefined || value === null || value === '') {
    return null;
  }
  switch (dataType) {
    case 'INTEGER':
    case 'BIGINT':
    case 'NUMERIC': {
      const n = typeof value === 'number' ? value : Number(String(value).trim());
      return Number.isFinite(n) ? n : value;
    }
    case 'BOOLEAN': {
      if (typeof value === 'boolean') return value;
      const s = String(value).trim().toLowerCase();
      if (s === 'true') return true;
      if (s === 'false') return false;
      return value;
    }
    default:
      return value;
  }
}

/** Up-front JS validation for EMAIL / RANGE (DB enforces the rest). */
function validate(entity: Entity, record: EntityRecord): string[] {
  const errors: string[] = [];
  for (const attr of entity.attributes) {
    const value = record[attr.name];
    for (const c of attr.constraints) {
      if (c.kind === 'FORMAT' && value !== null && value !== undefined && value !== '') {
        if (typeof value !== 'string' || !isValidEmail(value)) {
          errors.push(`${attr.name} must be a valid email address`);
        }
      }
      if (c.kind === 'RANGE' && value !== null && value !== undefined && value !== '') {
        const n = Number(value);
        if (!Number.isFinite(n)) {
          errors.push(`${attr.name} must be a number`);
        } else {
          if (c.min !== undefined && n < c.min) errors.push(`${attr.name} must be >= ${c.min}`);
          if (c.max !== undefined && n > c.max) errors.push(`${attr.name} must be <= ${c.max}`);
        }
      }
    }
  }
  return errors;
}

/** Map a pg error to a friendly message for a 400. */
function pgErrorMessage(error: unknown, entity: string): string {
  const code = (error as { code?: string })?.code;
  const detail = (error as { detail?: string })?.detail;
  switch (code) {
    case '23505':
      return `A ${entity} with these values already exists (unique constraint).${detail ? ' ' + detail : ''}`;
    case '23503':
      return `Referenced record does not exist (foreign key).${detail ? ' ' + detail : ''}`;
    case '23502':
      return `A required field is missing (not-null constraint).`;
    case '23514':
      return `A value violates a check constraint.`;
    case '22P02':
    case '22003':
      return `A value has the wrong type for its column.`;
    default:
      return error instanceof Error ? error.message : String(error);
  }
}

function validationOutcome(entity: string, messages: string[]): CrudOutcome<never> {
  return {
    ok: false,
    status: 400,
    error: {
      kind: 'VALIDATION_ERROR',
      message: `${entity} payload violated ${messages.length} constraint(s)`,
      violations: messages.map((m) => ({ attribute: '', kind: 'NOT_NULL', message: m })),
    } as any,
  };
}

function notFoundOutcome(entity: string, pk: unknown): CrudOutcome<never> {
  return {
    ok: false,
    status: 404,
    error: {
      kind: 'NOT_FOUND',
      message: `No ${entity} record found for the given primary key`,
      entityName: entity,
      primaryKey: { value: pk },
    } as any,
  };
}

const MAX_PAGE = 100;
const DEFAULT_PAGE = 25;
function clampSize(n: number | undefined): number {
  if (n === undefined || !Number.isFinite(n)) return DEFAULT_PAGE;
  return Math.min(MAX_PAGE, Math.max(1, Math.floor(n)));
}

// ---------------------------------------------------------------------------
// CRUD operations
// ---------------------------------------------------------------------------

/** List / search / filter rows for an entity, bounded to a page. */
export async function pgList(
  schema: string,
  model: DataModel,
  entity: string,
  searchable: string[],
  params: ListParams,
): Promise<QueryResult<EntityRecord> | { error: string }> {
  const ent = entityOf(model, entity);
  if (!ent) return { error: `Unknown entity "${entity}"` };

  const pool = await getPool();
  const size = clampSize(params.size);
  const page = params.page && params.page > 0 ? Math.floor(params.page) : 1;
  const offset = (page - 1) * size;

  const where: string[] = [];
  const values: unknown[] = [];

  if (params.search && params.search.trim() !== '' && searchable.length > 0) {
    const term = `%${params.search.trim()}%`;
    values.push(term);
    const idx = values.length;
    const ors = searchable.map((a) => `${quoteIdent(a)}::text ILIKE $${idx}`);
    where.push(`(${ors.join(' OR ')})`);
  }

  if (params.filterAttribute && params.filterOperator) {
    const col = ent.attributes.find((a) => a.name === params.filterAttribute);
    if (col) {
      const op = SQL_OP[params.filterOperator];
      if (params.filterOperator === 'contains') {
        values.push(`%${params.filterValue ?? ''}%`);
        where.push(`${quoteIdent(col.name)}::text ILIKE $${values.length}`);
      } else {
        values.push(coerce(params.filterValue, col.dataType));
        where.push(`${quoteIdent(col.name)} ${op} $${values.length}`);
      }
    }
  }

  const whereSql = where.length > 0 ? ` WHERE ${where.join(' AND ')}` : '';
  const orderSql = ` ORDER BY ${ent.primaryKey.map(quoteIdent).join(', ')} ASC`;

  const countRes = await pool.query(
    `SELECT count(*)::int AS n FROM ${qualified(schema, entity)}${whereSql}`,
    values,
  );
  const total = countRes.rows[0]?.n ?? 0;

  const rowsRes = await pool.query(
    `SELECT * FROM ${qualified(schema, entity)}${whereSql}${orderSql} LIMIT ${size} OFFSET ${offset}`,
    values,
  );

  return {
    records: rowsRes.rows as EntityRecord[],
    total,
    isEmpty: total === 0,
    page,
    pageSize: size,
  };
}

const SQL_OP: Record<FilterOperator, string> = {
  eq: '=',
  neq: '<>',
  contains: 'ILIKE',
  gt: '>',
  gte: '>=',
  lt: '<',
  lte: '<=',
};

/** Insert a new row; auto-generates a UUID primary key when absent. */
export async function pgCreate(
  schema: string,
  model: DataModel,
  entity: string,
  payload: EntityRecord,
): Promise<CrudOutcome<EntityRecord>> {
  const ent = entityOf(model, entity);
  if (!ent) return notFoundOutcome(entity, undefined) as CrudOutcome<EntityRecord>;

  const record: EntityRecord = {};
  for (const attr of ent.attributes) {
    if (Object.prototype.hasOwnProperty.call(payload, attr.name)) {
      record[attr.name] = coerce(payload[attr.name], attr.dataType);
    }
  }
  // Surrogate key for a missing single-column primary key.
  if (ent.primaryKey.length === 1) {
    const pkCol = ent.attributes.find((a) => a.name === ent.primaryKey[0]);
    const missing = pkCol && (record[pkCol.name] === undefined || record[pkCol.name] === null);
    if (pkCol && missing) {
      if (pkCol.dataType === 'UUID') {
        record[pkCol.name] = randomUUID();
      } else if (pkCol.dataType === 'INTEGER' || pkCol.dataType === 'BIGINT') {
        // Imported tables lose SERIAL auto-increment in migration; derive the
        // next id as max(pk)+1 so dashboard inserts still work.
        try {
          const pool = await getPool();
          const r = await pool.query(
            `SELECT COALESCE(MAX(${quoteIdent(pkCol.name)}), 0) + 1 AS next ` +
              `FROM ${qualified(schema, entity)}`,
          );
          record[pkCol.name] = Number(r.rows[0]?.next ?? 1);
        } catch {
          // Fall through; the insert will surface a clear error if needed.
        }
      }
    }
  }

  const errors = validate(ent, record);
  if (errors.length > 0) return validationOutcome(entity, errors);

  const columns = Object.keys(record);
  if (columns.length === 0) return validationOutcome(entity, ['no insertable columns provided']);
  const placeholders = columns.map((_, i) => `$${i + 1}`).join(', ');
  const sql =
    `INSERT INTO ${qualified(schema, entity)} (${columns.map(quoteIdent).join(', ')}) ` +
    `VALUES (${placeholders}) RETURNING *`;

  try {
    const pool = await getPool();
    const res = await pool.query(sql, columns.map((c) => record[c]));
    return { ok: true, value: res.rows[0] as EntityRecord };
  } catch (error) {
    return validationOutcome(entity, [pgErrorMessage(error, entity)]);
  }
}

/** Update a row addressed by a single-column primary key value. */
export async function pgUpdate(
  schema: string,
  model: DataModel,
  entity: string,
  pk: string,
  payload: EntityRecord,
): Promise<CrudOutcome<EntityRecord>> {
  const ent = entityOf(model, entity);
  if (!ent) return notFoundOutcome(entity, pk) as CrudOutcome<EntityRecord>;
  if (ent.primaryKey.length !== 1) {
    return validationOutcome(entity, ['composite primary keys are not editable via this route']);
  }
  const pkCol = ent.primaryKey[0];
  const pkAttr = ent.attributes.find((a) => a.name === pkCol)!;

  // Build SET from non-PK columns present in the payload.
  const setCols: string[] = [];
  const values: unknown[] = [];
  for (const attr of ent.attributes) {
    if (attr.name === pkCol) continue;
    if (Object.prototype.hasOwnProperty.call(payload, attr.name)) {
      values.push(coerce(payload[attr.name], attr.dataType));
      setCols.push(`${quoteIdent(attr.name)} = $${values.length}`);
    }
  }
  if (setCols.length === 0) {
    return validationOutcome(entity, ['no updatable fields provided']);
  }

  // Validate the resulting row's email/range using payload values.
  const candidate: EntityRecord = {};
  for (const attr of ent.attributes) {
    if (Object.prototype.hasOwnProperty.call(payload, attr.name)) {
      candidate[attr.name] = coerce(payload[attr.name], attr.dataType);
    }
  }
  const errors = validate(ent, candidate);
  if (errors.length > 0) return validationOutcome(entity, errors);

  values.push(coerce(pk, pkAttr.dataType));
  const sql =
    `UPDATE ${qualified(schema, entity)} SET ${setCols.join(', ')} ` +
    `WHERE ${quoteIdent(pkCol)} = $${values.length} RETURNING *`;

  try {
    const pool = await getPool();
    const res = await pool.query(sql, values);
    if ((res.rowCount ?? 0) === 0) return notFoundOutcome(entity, pk) as CrudOutcome<EntityRecord>;
    return { ok: true, value: res.rows[0] as EntityRecord };
  } catch (error) {
    return validationOutcome(entity, [pgErrorMessage(error, entity)]);
  }
}

/** Delete a row by single-column primary key value. */
export async function pgDelete(
  schema: string,
  model: DataModel,
  entity: string,
  pk: string,
): Promise<CrudOutcome<{ deleted: true }>> {
  const ent = entityOf(model, entity);
  if (!ent) return notFoundOutcome(entity, pk) as CrudOutcome<{ deleted: true }>;
  if (ent.primaryKey.length !== 1) {
    return validationOutcome(entity, ['composite primary keys are not deletable via this route']) as CrudOutcome<{ deleted: true }>;
  }
  const pkCol = ent.primaryKey[0];
  const pkAttr = ent.attributes.find((a) => a.name === pkCol)!;

  const sql = `DELETE FROM ${qualified(schema, entity)} WHERE ${quoteIdent(pkCol)} = $1`;
  try {
    const pool = await getPool();
    const res = await pool.query(sql, [coerce(pk, pkAttr.dataType)]);
    if ((res.rowCount ?? 0) === 0) return notFoundOutcome(entity, pk) as CrudOutcome<{ deleted: true }>;
    return { ok: true, value: { deleted: true } };
  } catch (error) {
    return validationOutcome(entity, [pgErrorMessage(error, entity)]) as CrudOutcome<{ deleted: true }>;
  }
}
