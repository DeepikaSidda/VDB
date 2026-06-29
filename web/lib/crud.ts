/**
 * Dashboard CRUD helpers: glue between the route handlers and a deployed
 * session's data.
 *
 * Two backings are supported, chosen per session:
 * - **Live Postgres** — when the generation deployed to a real Aurora/RDS
 *   target, every operation runs as SQL against that generation's schema
 *   (`gen_<id>`) via {@link ./pgStore}, so the dashboard reads and mutates the
 *   actual database.
 * - **In-memory** — the local/demo path uses the generated {@link EntityCrudSet}
 *   runtime over the in-process store.
 *
 * These functions implement the data side of Req 7.3–7.8: list / search /
 * filter records bounded to a page, and create / update / delete returning a
 * tagged result so the route handler can map success to 2xx and a constraint
 * violation / not-found to the right error status.
 */

import type { EntityCrud, EntityRecord, Page, ValidationError, NotFoundError } from '../../dist/src/api/crudRuntime.js';
import {
  searchRecords,
  filterRecords,
  type Filter,
  type FilterOperator,
  type QueryResult,
} from '../../dist/src/dashboard/query.js';
import type { GenerationSession } from './backend';
import { pgList, pgCreate, pgUpdate, pgDelete } from './pgStore';

/** A tagged outcome for create/update/delete so handlers can pick a status. */
export type CrudOutcome<T> =
  | { ok: true; value: T }
  | { ok: false; status: 400 | 404; error: ValidationError | NotFoundError };

export type ListParams = {
  page?: number;
  size?: number;
  search?: string;
  filterAttribute?: string;
  filterOperator?: FilterOperator;
  filterValue?: string;
};

/**
 * The live Postgres schema for a session, or `undefined` when the session is
 * in-memory backed. Present only when the deploy actually persisted data to a
 * real database.
 */
function pgSchema(session: GenerationSession): string | undefined {
  const dp = session.dataPersistence;
  return dp && dp.ok && dp.schema ? dp.schema : undefined;
}

function crud(session: GenerationSession, entity: string): EntityCrud | undefined {
  return session.backend?.crud.get(entity);
}

/** The declared searchable attributes for an entity, from the descriptor. */
function searchableAttributes(session: GenerationSession, entity: string): string[] {
  const view = session.backend?.dashboard.entities.find((e) => e.entityName === entity);
  return view?.searchableAttributes ?? [];
}

function coerceValue(raw: string): unknown {
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  if (raw.trim() !== '' && Number.isFinite(Number(raw))) {
    return Number(raw);
  }
  return raw;
}

/**
 * List, search, or filter an entity's records, bounded to a page (Req 7.2,
 * 7.6–7.8). Routes to live Postgres when the session is database-backed.
 */
export async function listRecords(
  session: GenerationSession,
  entity: string,
  params: ListParams,
): Promise<QueryResult<EntityRecord> | { error: string }> {
  const schema = pgSchema(session);
  if (schema && session.backend) {
    return pgList(
      schema,
      session.backend.model,
      entity,
      searchableAttributes(session, entity),
      params,
    );
  }

  const ops = crud(session, entity);
  if (!ops) {
    return { error: `Unknown entity "${entity}"` };
  }

  const page = { page: params.page, size: params.size };
  const all = session.backend!.crud.store.entries(entity).map((e) => e.record as EntityRecord);

  if (params.search && params.search.trim() !== '') {
    return searchRecords(all, params.search, searchableAttributes(session, entity), page);
  }
  if (params.filterAttribute && params.filterOperator) {
    const filter: Filter = {
      attribute: params.filterAttribute,
      operator: params.filterOperator,
      value: coerceValue(params.filterValue ?? ''),
    };
    return filterRecords(all, [filter], page);
  }

  const listed = ops.list({ page: params.page, size: params.size });
  if (!listed.ok) {
    return { error: listed.error.message };
  }
  const result: Page<EntityRecord> = listed.value;
  return {
    records: result.records,
    total: result.total,
    isEmpty: result.total === 0,
    page: result.page,
    pageSize: result.pageSize,
  };
}

/** Create a record (Req 7.3/7.4 success, 7.5 failure). */
export async function createRecord(
  session: GenerationSession,
  entity: string,
  payload: EntityRecord,
): Promise<CrudOutcome<EntityRecord>> {
  const schema = pgSchema(session);
  if (schema && session.backend) {
    return pgCreate(schema, session.backend.model, entity, payload);
  }
  const ops = crud(session, entity);
  if (!ops) return notFoundEntity(entity);
  const result = ops.create(payload);
  if (result.ok) return { ok: true, value: result.value };
  return { ok: false, status: 400, error: result.error };
}

/** Update a record by primary key. */
export async function updateRecord(
  session: GenerationSession,
  entity: string,
  pk: string,
  payload: EntityRecord,
): Promise<CrudOutcome<EntityRecord>> {
  const schema = pgSchema(session);
  if (schema && session.backend) {
    return pgUpdate(schema, session.backend.model, entity, pk, payload);
  }
  const ops = crud(session, entity);
  if (!ops) return notFoundEntity(entity);
  const result = ops.update(pk, payload);
  if (result.ok) return { ok: true, value: result.value };
  const status = result.error.kind === 'NOT_FOUND' ? 404 : 400;
  return { ok: false, status, error: result.error };
}

/** Delete a record by primary key. */
export async function deleteRecord(
  session: GenerationSession,
  entity: string,
  pk: string,
): Promise<CrudOutcome<{ deleted: true }>> {
  const schema = pgSchema(session);
  if (schema && session.backend) {
    return pgDelete(schema, session.backend.model, entity, pk);
  }
  const ops = crud(session, entity);
  if (!ops) return notFoundEntity(entity);
  const result = ops.delete(pk);
  if (result.ok) return { ok: true, value: { deleted: true } };
  return { ok: false, status: 404, error: result.error };
}

function notFoundEntity(entity: string): CrudOutcome<never> {
  return {
    ok: false,
    status: 404,
    error: {
      kind: 'NOT_FOUND',
      message: `Unknown entity "${entity}"`,
      entityName: entity,
      primaryKey: {},
    },
  };
}
