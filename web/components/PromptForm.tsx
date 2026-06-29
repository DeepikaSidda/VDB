'use client';

import { useState } from 'react';

const EXAMPLES = [
  'Build a hotel booking system',
  'A library with members, books, loans, and authors',
  'An online store with products, customers, orders, and reviews',
];

/**
 * The prompt input (Req 1 entry point): a textarea + Generate button that
 * starts a generation run. Calls back with the prompt; submission is disabled
 * while a run is in flight.
 */
export function PromptForm({
  onGenerate,
  busy,
}: {
  onGenerate: (prompt: string) => void;
  busy: boolean;
}) {
  const [prompt, setPrompt] = useState('');

  const submit = () => {
    const trimmed = prompt.trim();
    if (trimmed === '' || busy) return;
    onGenerate(trimmed);
  };

  return (
    <section className="panel">
      <h2>Describe your domain</h2>
      <textarea
        value={prompt}
        placeholder="e.g. Build a hotel booking system with rooms, guests, bookings, and payments."
        onChange={(e) => setPrompt(e.target.value)}
        disabled={busy}
        aria-label="Domain description"
      />
      <div className="row" style={{ marginTop: '0.6rem' }}>
        <button onClick={submit} disabled={busy || prompt.trim() === ''}>
          {busy ? 'Generating…' : 'Generate backend'}
        </button>
        <span className="muted">or try:</span>
        {EXAMPLES.map((ex) => (
          <button
            key={ex}
            className="secondary"
            disabled={busy}
            onClick={() => setPrompt(ex)}
            type="button"
          >
            {ex}
          </button>
        ))}
      </div>
    </section>
  );
}
