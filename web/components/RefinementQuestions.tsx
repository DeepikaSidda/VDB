'use client';

import { useEffect, useState } from 'react';
import type { ClarifyingQuestion } from '@/lib/clientTypes';

/**
 * The refinement question UI (Req 8.1/8.2/8.6). Fetches the clarifying questions
 * derived from the generated model — each grounded in an entity/attribute/
 * relationship — and renders them with selectable options plus a Skip control.
 *
 * Interactive refinement is optional/skippable in this slice (Req 8.6): the
 * pipeline already runs refinement non-interactively, so both "Continue" and
 * "Skip" simply dismiss the panel and proceed to the dashboard. The panel is
 * collapsible so it never blocks the demo flow.
 */
export function RefinementQuestions({
  generationId,
  onDone,
}: {
  generationId: string;
  onDone: () => void;
}) {
  const [questions, setQuestions] = useState<ClarifyingQuestion[] | null>(null);
  const [selected, setSelected] = useState<Record<string, string>>({});

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/generate/${generationId}/questions`)
      .then((r) => r.json())
      .then((data: { questions?: ClarifyingQuestion[] }) => {
        if (!cancelled) setQuestions(data.questions ?? []);
      })
      .catch(() => {
        if (!cancelled) setQuestions([]);
      });
    return () => {
      cancelled = true;
    };
  }, [generationId]);

  if (questions === null) {
    return (
      <section className="panel">
        <h2>Refinement</h2>
        <p className="muted">
          <span className="spinner" />
          Deriving clarifying questions…
        </p>
      </section>
    );
  }

  if (questions.length === 0) {
    return null;
  }

  return (
    <section className="panel">
      <h2>Refine your model (optional)</h2>
      <p className="muted">
        Optional clarifying questions grounded in your model. You can answer or
        skip — generation has already proceeded with sensible defaults.
      </p>
      {questions.map((q) => (
        <div key={q.id} className="question">
          <strong>{q.prompt}</strong>
          <div className="options">
            {q.options.map((opt) => (
              <label key={opt.id} className="row" style={{ gap: '0.4rem' }}>
                <input
                  type="radio"
                  name={q.id}
                  style={{ width: 'auto' }}
                  checked={selected[q.id] === opt.id}
                  onChange={() =>
                    setSelected((s) => ({ ...s, [q.id]: opt.id }))
                  }
                />
                <span>{opt.label}</span>
              </label>
            ))}
          </div>
        </div>
      ))}
      <div className="row" style={{ marginTop: '0.6rem' }}>
        <button onClick={onDone}>Continue to dashboard</button>
        <button className="secondary" onClick={onDone}>
          Skip
        </button>
      </div>
    </section>
  );
}
