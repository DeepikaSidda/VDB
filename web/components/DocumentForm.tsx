'use client';

import { useState } from 'react';

type DocPayload = {
  name: string;
  format?: string;
  contentType?: string;
  content: string;
  encoding: 'utf8' | 'base64';
};

/** Read a File as UTF-8 text (for CSV). */
function readText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.onerror = () => reject(reader.error);
    reader.readAsText(file);
  });
}

/** Read a File as base64 (for Excel/PDF) via a data URL. */
function readBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result ?? '');
      resolve(result.slice(result.indexOf(',') + 1));
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

function extOf(name: string): string {
  const i = name.lastIndexOf('.');
  return i >= 0 ? name.slice(i + 1).toLowerCase() : '';
}

/**
 * Document → Backend (Req 10): upload a CSV / Excel / PDF and the engine infers
 * a relational model from it. CSV is read as text; Excel/PDF as base64.
 */
export function DocumentForm({
  onGenerate,
  busy,
}: {
  onGenerate: (body: { mode: 'document'; document: DocPayload }) => void;
  busy: boolean;
}) {
  const [fileName, setFileName] = useState('');
  const [error, setError] = useState<string | null>(null);

  const onFile = async (file: File | undefined) => {
    setError(null);
    if (!file) return;
    setFileName(file.name);
    const ext = extOf(file.name);
    try {
      let payload: DocPayload;
      if (ext === 'csv' || file.type === 'text/csv') {
        payload = { name: file.name, format: 'csv', content: await readText(file), encoding: 'utf8' };
      } else if (ext === 'xlsx' || ext === 'xls') {
        payload = { name: file.name, format: 'xlsx', content: await readBase64(file), encoding: 'base64' };
      } else if (ext === 'pdf') {
        payload = { name: file.name, format: 'pdf', content: await readBase64(file), encoding: 'base64' };
      } else {
        setError('Unsupported file type. Upload a CSV, Excel (.xlsx), or PDF file.');
        return;
      }
      onGenerate({ mode: 'document', document: payload });
    } catch {
      setError('Could not read the file.');
    }
  };

  return (
    <section className="panel">
      <h2>Upload a document</h2>
      <p className="muted">
        CSV, Excel, or PDF. The engine detects entities and relationships
        (e.g. a flat attendance sheet becomes Students + Faculty + Attendance).
      </p>
      <input
        type="file"
        accept=".csv,.xlsx,.xls,.pdf"
        disabled={busy}
        onChange={(e) => void onFile(e.target.files?.[0])}
        aria-label="Upload document"
      />
      {fileName && <div className="muted" style={{ marginTop: '0.5rem' }}>Selected: {fileName}</div>}
      {error && <div className="error-box">{error}</div>}
    </section>
  );
}
