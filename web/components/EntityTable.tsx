'use client';

import { useCallback, useEffect, useState } from 'react';
import type { EntityView, RecordsPage } from '@/lib/clientTypes';

type FilterOp = 'eq' | 'neq' | 'contains' | 'gt' | 'gte' | 'lt' | 'lte';

/**
 * The records table for one entity, rendered from its {@link EntityView}
 * descriptor (Req 7.2). Provides pagination, search over the descriptor's
 * searchable attributes (Req 7.6), an attribute filter (Req 7.7), an
 * empty-result indication (Req 7.8), and Add / Edit / Delete actions wired to
 * the generated CRUD APIs (Req 7.3).
 *
 * On a successful action the table refetches so it reflects the updated state
 * (Req 7.4); on a failed action it shows the error and leaves the displayed
 * records unchanged (Req 7.5).
 */
export function EntityTable({
  generationId,
  view,
}: {
  generationId: string;
  view: EntityView;
}) {
  const pkColumns = view.columns.filter((c) => c.isPrimaryKey).map((c) => c.name);
  const pkColumn = pkColumns[0] ?? view.columns[0]?.name ?? '';

  const [page, setPage] = useState<RecordsPage | null>(null);
  const [pageIndex, setPageIndex] = useState(1);
  const [search, setSearch] = useState('');
  const [filterAttr, setFilterAttr] = useState('');
  const [filterOp, setFilterOp] = useState<FilterOp>('eq');
  const [filterVal, setFilterVal] = useState('');
  const [error, setError] = useState<string | null>(null);

  const base = `/api/generate/${generationId}/entities/${encodeURIComponent(view.entityName)}`;

  const load = useCallback(async () => {
    const params = new URLSearchParams();
    params.set('page', String(pageIndex));
    params.set('size', String(view.pageSize));
    if (search.trim() !== '') params.set('search', search.trim());
    if (filterAttr !== '' && filterVal !== '') {
      params.set('filterAttr', filterAttr);
      params.set('filterOp', filterOp);
      params.set('filterVal', filterVal);
    }
    try {
      const res = await fetch(`${base}?${params.toString()}`);
      const data = await res.json();
      if (!res.ok) {
        setError(typeof data.error === 'string' ? data.error : 'Failed to load records.');
        return;
      }
      setPage(data as RecordsPage);
    } catch {
      setError('Failed to load records.');
    }
  }, [base, pageIndex, view.pageSize, search, filterAttr, filterOp, filterVal]);

  // Reset to page 1 and reload when the entity changes.
  useEffect(() => {
    setPageIndex(1);
    setSearch('');
    setFilterAttr('');
    setFilterVal('');
  }, [view.entityName]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div>
      <Toolbar
        view={view}
        search={search}
        setSearch={setSearch}
        filterAttr={filterAttr}
        setFilterAttr={setFilterAttr}
        filterOp={filterOp}
        setFilterOp={setFilterOp}
        filterVal={filterVal}
        setFilterVal={setFilterVal}
        onApply={() => {
          setPageIndex(1);
          void load();
        }}
        onClear={() => {
          setSearch('');
          setFilterAttr('');
          setFilterVal('');
          setPageIndex(1);
        }}
      />

      {error && <div className="error-box">{error}</div>}

      <AddRecordForm
        view={view}
        onSubmit={async (payload) => {
          setError(null);
          const res = await fetch(base, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(payload),
          });
          const data = await res.json();
          if (!res.ok) {
            setError(formatError(data.error) ?? 'Create failed.');
            return false;
          }
          await load();
          return true;
        }}
      />

      {page && page.isEmpty ? (
        <p className="muted">No records match.</p>
      ) : (
        <table>
          <thead>
            <tr>
              {view.columns.map((c) => (
                <th key={c.name}>
                  {c.name}
                  {c.isPrimaryKey && <span className="tag">PK</span>}
                  {c.isForeignKey && <span className="tag">FK</span>}
                  {c.isUnique && <span className="tag">unique</span>}
                </th>
              ))}
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {page?.records.map((record, i) => (
              <EditableRow
                key={String(record[pkColumn] ?? i)}
                view={view}
                record={record}
                pkColumn={pkColumn}
                onSave={async (pk, payload) => {
                  setError(null);
                  const res = await fetch(`${base}/${encodeURIComponent(String(pk))}`, {
                    method: 'PUT',
                    headers: { 'content-type': 'application/json' },
                    body: JSON.stringify(payload),
                  });
                  const data = await res.json();
                  if (!res.ok) {
                    setError(formatError(data.error) ?? 'Update failed.');
                    return false;
                  }
                  await load();
                  return true;
                }}
                onDelete={async (pk) => {
                  setError(null);
                  const res = await fetch(`${base}/${encodeURIComponent(String(pk))}`, {
                    method: 'DELETE',
                  });
                  if (!res.ok) {
                    const data = await res.json().catch(() => ({}));
                    setError(formatError(data.error) ?? 'Delete failed.');
                    return;
                  }
                  await load();
                }}
              />
            ))}
          </tbody>
        </table>
      )}

      {page && (
        <div className="row" style={{ marginTop: '0.75rem' }}>
          <button
            className="secondary"
            disabled={pageIndex <= 1}
            onClick={() => setPageIndex((p) => Math.max(1, p - 1))}
          >
            ← Prev
          </button>
          <span className="muted">
            Page {page.page} · {page.total} record(s) · page size {page.pageSize}
          </span>
          <button
            className="secondary"
            disabled={pageIndex * page.pageSize >= page.total}
            onClick={() => setPageIndex((p) => p + 1)}
          >
            Next →
          </button>
        </div>
      )}
    </div>
  );
}

function Toolbar(props: {
  view: EntityView;
  search: string;
  setSearch: (v: string) => void;
  filterAttr: string;
  setFilterAttr: (v: string) => void;
  filterOp: FilterOp;
  setFilterOp: (v: FilterOp) => void;
  filterVal: string;
  setFilterVal: (v: string) => void;
  onApply: () => void;
  onClear: () => void;
}) {
  const { view } = props;
  return (
    <div className="toolbar">
      {view.searchableAttributes.length > 0 && (
        <div className="field">
          <label>Search ({view.searchableAttributes.join(', ')})</label>
          <input
            value={props.search}
            placeholder="contains…"
            onChange={(e) => props.setSearch(e.target.value)}
          />
        </div>
      )}
      <div className="field">
        <label>Filter attribute</label>
        <select
          value={props.filterAttr}
          onChange={(e) => props.setFilterAttr(e.target.value)}
        >
          <option value="">— none —</option>
          {view.filterableAttributes.map((a) => (
            <option key={a} value={a}>
              {a}
            </option>
          ))}
        </select>
      </div>
      <div className="field">
        <label>Operator</label>
        <select
          value={props.filterOp}
          onChange={(e) => props.setFilterOp(e.target.value as FilterOp)}
        >
          {(['eq', 'neq', 'contains', 'gt', 'gte', 'lt', 'lte'] as FilterOp[]).map(
            (op) => (
              <option key={op} value={op}>
                {op}
              </option>
            ),
          )}
        </select>
      </div>
      <div className="field">
        <label>Value</label>
        <input
          value={props.filterVal}
          onChange={(e) => props.setFilterVal(e.target.value)}
        />
      </div>
      <button onClick={props.onApply}>Apply</button>
      <button className="secondary" onClick={props.onClear}>
        Clear
      </button>
    </div>
  );
}

function AddRecordForm({
  view,
  onSubmit,
}: {
  view: EntityView;
  onSubmit: (payload: Record<string, unknown>) => Promise<boolean>;
}) {
  const [open, setOpen] = useState(false);
  const [values, setValues] = useState<Record<string, string>>({});

  if (!open) {
    return (
      <div style={{ margin: '0.5rem 0' }}>
        <button onClick={() => setOpen(true)}>+ Add {view.entityName}</button>
      </div>
    );
  }

  return (
    <div className="panel" style={{ background: 'var(--panel-2)' }}>
      <strong>New {view.entityName}</strong>
      <div className="form-grid">
        {view.columns.map((c) => (
          <div key={c.name} className="field">
            <label>
              {c.name}
              {c.isPrimaryKey && c.dataType === 'UUID' ? ' (auto if blank)' : ''}
            </label>
            <input
              value={values[c.name] ?? ''}
              placeholder={c.dataType}
              onChange={(e) =>
                setValues((v) => ({ ...v, [c.name]: e.target.value }))
              }
            />
          </div>
        ))}
      </div>
      <div className="row">
        <button
          onClick={async () => {
            const ok = await onSubmit(coercePayload(view, values));
            if (ok) {
              setValues({});
              setOpen(false);
            }
          }}
        >
          Create
        </button>
        <button
          className="secondary"
          onClick={() => {
            setValues({});
            setOpen(false);
          }}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

function EditableRow({
  view,
  record,
  pkColumn,
  onSave,
  onDelete,
}: {
  view: EntityView;
  record: Record<string, unknown>;
  pkColumn: string;
  onSave: (pk: unknown, payload: Record<string, unknown>) => Promise<boolean>;
  onDelete: (pk: unknown) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [values, setValues] = useState<Record<string, string>>({});
  const pk = record[pkColumn];

  const startEdit = () => {
    const initial: Record<string, string> = {};
    for (const c of view.columns) {
      const v = record[c.name];
      initial[c.name] = v === null || v === undefined ? '' : String(v);
    }
    setValues(initial);
    setEditing(true);
  };

  if (editing) {
    return (
      <tr>
        {view.columns.map((c) => (
          <td key={c.name}>
            <input
              value={values[c.name] ?? ''}
              disabled={c.isPrimaryKey}
              onChange={(e) =>
                setValues((v) => ({ ...v, [c.name]: e.target.value }))
              }
            />
          </td>
        ))}
        <td>
          <div className="row">
            <button
              onClick={async () => {
                const ok = await onSave(pk, coercePayload(view, values));
                if (ok) setEditing(false);
              }}
            >
              Save
            </button>
            <button className="secondary" onClick={() => setEditing(false)}>
              Cancel
            </button>
          </div>
        </td>
      </tr>
    );
  }

  return (
    <tr>
      {view.columns.map((c) => (
        <td key={c.name}>{formatCell(record[c.name])}</td>
      ))}
      <td>
        <div className="row">
          <button className="secondary" onClick={startEdit}>
            Edit
          </button>
          <button className="danger" onClick={() => void onDelete(pk)}>
            Delete
          </button>
        </div>
      </td>
    </tr>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Coerce form string inputs into typed values matching each column's data type,
 * so payloads satisfy the generated constraints (e.g. numeric RANGE, BOOLEAN).
 * Blank values are omitted so surrogate-key/optional handling on the backend
 * applies.
 */
function coercePayload(
  view: EntityView,
  values: Record<string, string>,
): Record<string, unknown> {
  const payload: Record<string, unknown> = {};
  for (const c of view.columns) {
    const raw = values[c.name];
    if (raw === undefined || raw === '') continue;
    switch (c.dataType) {
      case 'INTEGER':
      case 'BIGINT':
      case 'NUMERIC':
        payload[c.name] = Number(raw);
        break;
      case 'BOOLEAN':
        payload[c.name] = raw === 'true' || raw === '1';
        break;
      case 'JSON':
        try {
          payload[c.name] = JSON.parse(raw);
        } catch {
          payload[c.name] = raw;
        }
        break;
      default:
        payload[c.name] = raw;
    }
  }
  return payload;
}

function formatCell(value: unknown): string {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function formatError(error: unknown): string | null {
  if (!error) return null;
  if (typeof error === 'string') return error;
  const e = error as { message?: string; violations?: { message: string }[] };
  if (e.violations && e.violations.length > 0) {
    return `${e.message ?? 'Validation failed'}: ${e.violations
      .map((v) => v.message)
      .join('; ')}`;
  }
  return e.message ?? 'Action failed.';
}
