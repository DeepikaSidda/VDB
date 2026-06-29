'use client';

import { useState } from 'react';

type ImportBody = {
  mode: 'import';
  engine: 'postgres' | 'mysql';
  connection: { host: string; port: number; database: string; user: string; password: string };
};

/**
 * Existing Database Import (Req 11): connect to a live PostgreSQL or MySQL
 * database; the engine introspects its schema and migrates it to Aurora
 * PostgreSQL, generating APIs + dashboard.
 */
export function ImportForm({
  onGenerate,
  busy,
}: {
  onGenerate: (body: ImportBody) => void;
  busy: boolean;
}) {
  const [engine, setEngine] = useState<'postgres' | 'mysql'>('postgres');
  const [host, setHost] = useState('');
  const [port, setPort] = useState('');
  const [database, setDatabase] = useState('');
  const [user, setUser] = useState('');
  const [password, setPassword] = useState('');

  const submit = () => {
    if (busy || host.trim() === '' || database.trim() === '' || user.trim() === '') return;
    const parsedPort = Number(port) || (engine === 'mysql' ? 3306 : 5432);
    onGenerate({
      mode: 'import',
      engine,
      connection: { host: host.trim(), port: parsedPort, database: database.trim(), user: user.trim(), password },
    });
  };

  return (
    <section className="panel">
      <h2>Import an existing database</h2>
      <p className="muted">
        Connect to a live PostgreSQL or MySQL database. Its schema is analyzed
        and migrated to Aurora PostgreSQL.
      </p>
      <div className="form-grid">
        <label>
          Engine
          <select value={engine} disabled={busy} onChange={(e) => setEngine(e.target.value as 'postgres' | 'mysql')}>
            <option value="postgres">PostgreSQL</option>
            <option value="mysql">MySQL</option>
          </select>
        </label>
        <label>
          Host
          <input value={host} disabled={busy} onChange={(e) => setHost(e.target.value)} placeholder="db.example.com" />
        </label>
        <label>
          Port
          <input value={port} disabled={busy} onChange={(e) => setPort(e.target.value)} placeholder={engine === 'mysql' ? '3306' : '5432'} />
        </label>
        <label>
          Database
          <input value={database} disabled={busy} onChange={(e) => setDatabase(e.target.value)} placeholder="mydb" />
        </label>
        <label>
          User
          <input value={user} disabled={busy} onChange={(e) => setUser(e.target.value)} placeholder="readonly" />
        </label>
        <label>
          Password
          <input type="password" value={password} disabled={busy} onChange={(e) => setPassword(e.target.value)} />
        </label>
      </div>
      <div className="row" style={{ marginTop: '0.6rem' }}>
        <button onClick={submit} disabled={busy || host.trim() === '' || database.trim() === '' || user.trim() === ''}>
          {busy ? 'Importing…' : 'Import & generate'}
        </button>
      </div>
    </section>
  );
}
