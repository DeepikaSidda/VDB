'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { SessionSnapshot } from '@/lib/clientTypes';
import { PromptForm } from '@/components/PromptForm';
import { DocumentForm } from '@/components/DocumentForm';
import { ImportForm } from '@/components/ImportForm';
import { JobStatus } from '@/components/JobStatus';
import { RefinementQuestions } from '@/components/RefinementQuestions';
import { Dashboard } from '@/components/Dashboard';
import { SavedBackends } from '@/components/SavedBackends';
import { BackendInsights } from '@/components/BackendInsights';

/** Poll interval for the job-status view (Req 9.2: reflect a transition within 2s). */
const POLL_MS = 700;

type Mode = 'prompt' | 'document' | 'import';

const MODES: { id: Mode; label: string }[] = [
  { id: 'prompt', label: '1 · Prompt → Backend' },
  { id: 'document', label: '2 · Document → Backend' },
  { id: 'import', label: '3 · Import Database' },
];

/**
 * The single-page flow with all three ways to create a backend:
 *   1. Prompt input (Req 1).
 *   2. Document upload — CSV/Excel/PDF (Req 10).
 *   3. Existing database import — PostgreSQL/MySQL (Req 11).
 * Then a job-status view (Req 9.2), optional refinement (Req 8), and the
 * generated Admin_Dashboard (Req 7).
 */
export default function HomePage() {
  const [mode, setMode] = useState<Mode>('prompt');
  const [generationId, setGenerationId] = useState<string | null>(null);
  const [snapshot, setSnapshot] = useState<SessionSnapshot | null>(null);
  const [refinementDone, setRefinementDone] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const stopPolling = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  useEffect(() => {
    if (!generationId) return;
    let cancelled = false;
    const tick = async () => {
      try {
        const res = await fetch(`/api/generate/${generationId}`);
        if (!res.ok) return;
        const data = (await res.json()) as SessionSnapshot;
        if (cancelled) return;
        setSnapshot(data);
        if (data.status === 'deployed' || data.status === 'failed') {
          stopPolling();
        }
      } catch {
        /* transient; keep polling */
      }
    };
    void tick();
    pollRef.current = setInterval(tick, POLL_MS);
    return () => {
      cancelled = true;
      stopPolling();
    };
  }, [generationId, stopPolling]);

  /** POST any generation request body and begin tracking the run. */
  const start = useCallback(
    async (body: Record<string, unknown>) => {
      setStartError(null);
      setSnapshot(null);
      setRefinementDone(false);
      setGenerationId(null);
      setStarting(true);
      stopPolling();
      try {
        const res = await fetch('/api/generate', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });
        const data = await res.json();
        if (!res.ok) {
          setStartError(typeof data.error === 'string' ? data.error : 'Generation failed to start.');
          return;
        }
        setGenerationId((data as SessionSnapshot).id);
        setSnapshot(data as SessionSnapshot);
      } catch {
        setStartError('Could not reach the generation service.');
      } finally {
        setStarting(false);
      }
    },
    [stopPolling],
  );

  const reset = () => {
    stopPolling();
    setGenerationId(null);
    setSnapshot(null);
    setRefinementDone(false);
    setStartError(null);
  };

  const busy = snapshot?.status === 'running';
  const deployed = snapshot?.status === 'deployed' && snapshot.ready;

  return (
    <>
      {!generationId && !starting && (
        <>
          <div className="tabs">
            {MODES.map((m) => (
              <button
                key={m.id}
                type="button"
                className={mode === m.id ? 'tab active' : 'tab'}
                onClick={() => setMode(m.id)}
              >
                {m.label}
              </button>
            ))}
          </div>

          {mode === 'prompt' && (
            <PromptForm onGenerate={(prompt) => void start({ mode: 'prompt', prompt })} busy={false} />
          )}
          {mode === 'document' && (
            <DocumentForm onGenerate={(body) => void start(body)} busy={false} />
          )}
          {mode === 'import' && (
            <ImportForm onGenerate={(body) => void start(body)} busy={false} />
          )}

          <SavedBackends onOpen={(id) => setGenerationId(id)} />
        </>
      )}

      {starting && (
        <section className="panel" style={{ textAlign: 'center', padding: '2.5rem 1.5rem' }}>
          <span className="spinner" />
          <h2 style={{ marginTop: '0.75rem' }}>Generating your backend…</h2>
          <p className="muted">
            Modeling your data, deploying the schema to Amazon Aurora, loading rows, and
            generating the APIs &amp; dashboard. This can take up to ~30 seconds.
          </p>
        </section>
      )}

      {startError && <div className="error-box">{startError}</div>}

      {generationId && snapshot && (
        <>
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <span className="muted">
              Generation {generationId}
              {snapshot.dataPersistence?.schema && (
                <>
                  {' · '}
                  <span title="The Postgres schema in your live database">
                    DB schema <code>{snapshot.dataPersistence.schema}</code>
                  </span>
                </>
              )}
            </span>
            <button className="secondary" onClick={reset} disabled={busy}>
              ↺ New backend
            </button>
          </div>

          <JobStatus snapshot={snapshot} />

          {deployed && !refinementDone && (
            <RefinementQuestions
              generationId={generationId}
              onDone={() => setRefinementDone(true)}
            />
          )}

          {deployed && snapshot.dashboard && (
            <>
              <BackendInsights generationId={generationId} label={snapshot.label} />
              <Dashboard generationId={generationId} descriptor={snapshot.dashboard} />
            </>
          )}
        </>
      )}
    </>
  );
}
