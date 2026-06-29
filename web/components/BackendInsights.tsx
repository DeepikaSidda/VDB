'use client';

import { useEffect, useMemo, useState } from 'react';
import type { SchemaView, SchemaColumn, SchemaEntity } from '@/lib/clientTypes';

/** A human cardinality label. */
function cardinalityLabel(c: string): string {
  switch (c) {
    case 'ONE_TO_ONE':
      return '1 — 1';
    case 'MANY_TO_MANY':
      return 'N — N';
    default:
      return '1 — N';
  }
}

/** A placeholder value for a column type, used in the sample request body. */
function sampleValue(col: SchemaColumn): unknown {
  if (/email/i.test(col.name)) return 'user@example.com';
  switch (col.dataType) {
    case 'INTEGER':
    case 'BIGINT':
      return 0;
    case 'NUMERIC':
      return 0;
    case 'BOOLEAN':
      return true;
    case 'DATE':
      return '2024-01-01';
    case 'TIMESTAMP':
      return '2024-01-01T00:00:00Z';
    case 'JSON':
      return {};
    default:
      return 'text';
  }
}

/** Build a sample create body from an entity's non-PK, non-FK columns. */
function sampleBody(entity: SchemaEntity): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  for (const col of entity.columns) {
    if (col.pk || col.fk) continue;
    body[col.name] = sampleValue(col);
  }
  return body;
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="copy-btn"
      onClick={() => {
        void navigator.clipboard?.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 1200);
      }}
    >
      {copied ? 'Copied' : 'Copy'}
    </button>
  );
}

/**
 * Shows what the AI actually built: a structure diagram (entities + columns +
 * foreign-key relationships) and the generated REST API (live endpoints with
 * copy-paste curl). Fetched once from /api/generate/{id}/schema when deployed.
 */
export function BackendInsights({ generationId, label }: { generationId: string; label?: string }) {
  const [schema, setSchema] = useState<SchemaView | null>(null);
  const [origin, setOrigin] = useState('');
  const [tab, setTab] = useState<'structure' | 'api'>('structure');

  useEffect(() => {
    setOrigin(window.location.origin);
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(`/api/generate/${generationId}/schema`);
        if (!res.ok) return;
        const data = (await res.json()) as SchemaView;
        if (!cancelled) setSchema(data);
      } catch {
        /* ignore */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [generationId]);

  const counts = useMemo(() => {
    if (!schema) return { entities: 0, rels: 0 };
    return { entities: schema.entities.length, rels: schema.relationships.length };
  }, [schema]);

  if (!schema) {
    return null;
  }

  const base = `${origin}/api/generate/${generationId}/entities`;

  return (
    <section className="panel insights">
      <div className="insights-tabs">
        <button className={tab === 'structure' ? 'tab active' : 'tab'} onClick={() => setTab('structure')}>
          🧭 Detected structure
        </button>
        <button className={tab === 'api' ? 'tab active' : 'tab'} onClick={() => setTab('api')}>
          🔌 Generated REST API
        </button>
      </div>

      {tab === 'structure' && (
        <div>
          <p className="muted insights-summary">
            {label ? <>From <strong>{label}</strong> — </> : null}
            AI modeled <strong>{counts.entities}</strong> related table
            {counts.entities === 1 ? '' : 's'} with <strong>{counts.rels}</strong> foreign-key
            relationship{counts.rels === 1 ? '' : 's'}.
          </p>

          <div className="er-grid">
            {schema.entities.map((e) => (
              <div className={e.isJoin ? 'er-card join' : 'er-card'} key={e.name}>
                <div className="er-card-title">
                  {e.name}
                  {e.isJoin && <span className="er-tag">join</span>}
                </div>
                <table className="er-cols">
                  <tbody>
                    {e.columns.map((c) => (
                      <tr key={c.name}>
                        <td className="er-col-name">
                          {c.pk && <span title="Primary key">🔑</span>}
                          {c.fk && <span title="Foreign key">🔗</span>} {c.name}
                        </td>
                        <td className="er-col-type">{c.dataType.toLowerCase()}</td>
                        <td className="er-col-flags">
                          {c.notNull && <span className="flag">NN</span>}
                          {c.unique && <span className="flag">UQ</span>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ))}
          </div>

          {schema.relationships.length > 0 && (
            <div className="er-rels">
              <h4>Relationships</h4>
              {schema.relationships.map((r, i) => (
                <div className="er-edge" key={`${r.source}-${r.via}-${i}`}>
                  <span className="er-node">{r.source}</span>
                  <span className="er-arrow">
                    ──<span className="er-card-lbl">{cardinalityLabel(r.cardinality)}</span>▶
                  </span>
                  <span className="er-node">{r.target}</span>
                  <span className="muted er-via">via {r.via}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {tab === 'api' && (
        <div className="api-panel">
          <p className="muted">
            Every entity got a full CRUD REST API. These are live — copy a command and run it.
          </p>
          {schema.entities.map((e) => {
            const body = JSON.stringify(sampleBody(e));
            const rows = [
              { m: 'GET', label: 'List', url: `${base}/${e.name}?page=1&size=25`, curl: `curl '${base}/${e.name}?size=25'` },
              {
                m: 'POST',
                label: 'Create',
                url: `${base}/${e.name}`,
                curl: `curl -X POST '${base}/${e.name}' -H 'content-type: application/json' -d '${body}'`,
              },
              {
                m: 'PUT',
                label: 'Update',
                url: `${base}/${e.name}/{id}`,
                curl: `curl -X PUT '${base}/${e.name}/{id}' -H 'content-type: application/json' -d '${body}'`,
              },
              { m: 'DELETE', label: 'Delete', url: `${base}/${e.name}/{id}`, curl: `curl -X DELETE '${base}/${e.name}/{id}'` },
            ];
            return (
              <div className="api-entity" key={e.name}>
                <div className="api-entity-name">{e.name}</div>
                {rows.map((r) => (
                  <div className="api-row" key={r.label}>
                    <span className={`method method-${r.m}`}>{r.m}</span>
                    <code className="api-url">{r.url}</code>
                    <CopyButton text={r.curl} />
                  </div>
                ))}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
