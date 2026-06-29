'use client';

import { useCallback, useEffect, useState } from 'react';
import type { SavedGeneration } from '@/lib/clientTypes';

/**
 * "Saved backends" history: lists every backend previously generated into the
 * live database (the `gen_*` schemas) with row counts, and lets the user reopen
 * any of them straight into the dashboard. This is what makes past generations
 * discoverable again after a server restart — they live in the database, and
 * reopening introspects the schema back into a working backend.
 */
export function SavedBackends({ onOpen }: { onOpen: (generationId: string) => void }) {
  const [items, setItems] = useState<SavedGeneration[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [openingSchema, setOpeningSchema] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setError(null);
    try {
      const res = await fetch('/api/generations');
      const data = await res.json();
      setItems(Array.isArray(data.generations) ? data.generations : []);
      if (data.error) setError(String(data.error));
    } catch {
      setError('Could not load saved backends.');
      setItems([]);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const open = useCallback(
    async (schema: string) => {
      setOpeningSchema(schema);
      setError(null);
      try {
        const res = await fetch('/api/generations/open', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ schema }),
        });
        const data = await res.json();
        if (!res.ok) {
          setError(typeof data.error === 'string' ? data.error : 'Could not open this backend.');
          return;
        }
        onOpen(data.id as string);
      } catch {
        setError('Could not reach the server.');
      } finally {
        setOpeningSchema(null);
      }
    },
    [onOpen],
  );

  if (items === null) {
    return <div className="saved-backends muted">Loading saved backends…</div>;
  }

  return (
    <div className="saved-backends">
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
        <h3 style={{ margin: 0 }}>Your backends ({items.length})</h3>
        <button className="secondary" type="button" onClick={() => void refresh()}>
          ↻ Refresh
        </button>
      </div>
      {error && <div className="error-box">{error}</div>}
      {items.length === 0 && !error && (
        <p className="muted">
          No backends yet. Create one above (prompt, document, or import) and it will appear here,
          stored in your live database.
        </p>
      )}
      <div className="backend-grid">
        {items.map((g) => {
          const totalRows = g.tables.reduce((a, t) => a + t.rows, 0);
          return (
            <div className="backend-card" key={g.schema}>
              <div className="backend-card-head">
                <code className="schema-name">{g.schema}</code>
                {g.open && <span className="badge-open">open</span>}
              </div>
              <div className="backend-tables">
                {g.tables.length === 0 ? (
                  <span className="muted">no tables</span>
                ) : (
                  g.tables.map((t) => (
                    <span className="table-chip" key={t.name}>
                      {t.name} <strong>{t.rows}</strong>
                    </span>
                  ))
                )}
              </div>
              <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
                <span className="muted">{totalRows} row(s) in database</span>
                <button
                  type="button"
                  onClick={() => void open(g.schema)}
                  disabled={openingSchema === g.schema}
                >
                  {openingSchema === g.schema ? 'Opening…' : 'Open dashboard →'}
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
