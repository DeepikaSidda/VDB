'use client';

import { useState } from 'react';
import type { DashboardDescriptor } from '@/lib/clientTypes';
import { EntityTable } from './EntityTable';

/**
 * The generated Admin_Dashboard, rendered entirely from the
 * {@link DashboardDescriptor} (Req 7.1): a navigable list of the generated
 * entities and, for the selected entity, its records table with search/filter,
 * pagination, and create/edit/delete actions.
 */
export function Dashboard({
  generationId,
  descriptor,
}: {
  generationId: string;
  descriptor: DashboardDescriptor;
}) {
  const [selected, setSelected] = useState(
    descriptor.entities[0]?.entityName ?? '',
  );

  if (descriptor.entities.length === 0) {
    return (
      <section className="panel">
        <h2>Admin dashboard</h2>
        <p className="muted">The generated model has no entities to manage.</p>
      </section>
    );
  }

  const view =
    descriptor.entities.find((e) => e.entityName === selected) ??
    descriptor.entities[0];

  return (
    <section className="panel">
      <h2>Admin dashboard</h2>
      <p className="muted">
        {descriptor.entities.length} generated entit
        {descriptor.entities.length === 1 ? 'y' : 'ies'}. Manage records below —
        changes go through the generated CRUD APIs.
      </p>

      <nav className="entity-nav" aria-label="Entities">
        {descriptor.entities.map((e) => (
          <button
            key={e.entityName}
            className={e.entityName === view.entityName ? 'active' : ''}
            onClick={() => setSelected(e.entityName)}
          >
            {e.entityName}
          </button>
        ))}
      </nav>

      <h3 style={{ marginTop: 0 }}>{view.entityName}</h3>
      <EntityTable
        key={view.entityName}
        generationId={generationId}
        view={view}
      />
    </section>
  );
}
