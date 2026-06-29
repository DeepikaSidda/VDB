/**
 * Task 12.3 — unit/interaction tests for dashboard action wiring.
 *
 * The Admin_Dashboard renders from a `DashboardDescriptor` and drives its
 * create / edit / delete actions through the generated CRUD runtime
 * (`backend.crud`). These tests deploy a small live backend via the wired
 * `GenerationPipeline` and then exercise the dashboard data layer end to end:
 *
 *  - create / edit / delete invoke the *correct* CRUD operation (Req 7.3);
 *  - a successful action updates the view — the record is reflected on a
 *    subsequent read/list (Req 7.4);
 *  - a failed action leaves the records unchanged and surfaces an error
 *    indication (Req 7.5).
 *
 * These are interaction tests (not property tests): they assert the concrete
 * behavior of the wired dashboard → CRUD path against known examples and edge
 * cases. The CRUD operations are the data layer the dashboard's UI actions bind
 * to, so asserting their outcomes (and the descriptor that names them) verifies
 * the action wiring.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  createStubPipeline,
  type Backend,
} from '../../src/pipeline/pipeline.js';
import type { RawCandidateModel } from '../../src/modeling/llmClient.js';
import type { JobInput } from '../../src/model/types.js';
import { isOk, isErr } from '../../src/model/result.js';
import type { EntityCrud } from '../../src/api/crudRuntime.js';

/**
 * A minimal raw candidate yielding a single `Guest` entity. After modeling it
 * gains a surrogate UUID primary key (`id`), and constraint inference adds:
 *  - `email`: UNIQUE + NOT_NULL + FORMAT EMAIL (advisory unique/required hints
 *    plus the "email" name token),
 *  - `name`: NOT_NULL (advisory required hint).
 * That constraint set lets us drive both the success and the failure paths.
 */
const GUEST_CANDIDATE: RawCandidateModel = {
  entities: [
    {
      name: 'Guest',
      attributes: [
        { name: 'email', dataType: 'TEXT', unique: true, required: true },
        { name: 'name', dataType: 'TEXT', required: true },
      ],
    },
  ],
};

const PROMPT: JobInput = {
  kind: 'PROMPT',
  prompt: 'Build a guest registry',
};

/** Deploy a fresh live backend and hand back its `Guest` CRUD operations. */
async function deployGuestBackend(): Promise<{
  backend: Backend;
  guest: EntityCrud;
}> {
  const pipeline = createStubPipeline(GUEST_CANDIDATE);
  const { job, backend } = await pipeline.run(PROMPT);

  expect(job.status).toBe('deployed');
  if (backend === undefined) {
    throw new Error('expected a deployed backend');
  }
  const guest = backend.crud.get('Guest');
  if (guest === undefined) {
    throw new Error('expected a Guest CRUD');
  }
  return { backend, guest };
}

/** Read the auto-assigned primary key (`id`) from a created Guest record. */
function pkOf(record: Record<string, unknown>): string {
  const id = record['id'];
  if (typeof id !== 'string') {
    throw new Error('expected a string surrogate primary key');
  }
  return id;
}

describe('Task 12.3 — dashboard action wiring', () => {
  let backend: Backend;
  let guest: EntityCrud;

  beforeEach(async () => {
    ({ backend, guest } = await deployGuestBackend());
  });

  it('exposes a Guest view backed by the Guest CRUD (descriptor ↔ runtime)', () => {
    // The dashboard's actions bind to the entity views in the descriptor; each
    // view must have a matching CRUD entity to invoke (Req 7.1, 7.3).
    const views = backend.dashboard.entities.map((e) => e.entityName);
    expect(views).toContain('Guest');
    for (const name of views) {
      expect(backend.crud.get(name)).toBeDefined();
    }
  });

  describe('create action (Req 7.3, 7.4)', () => {
    it('invokes create and reflects the new record in the view on success', () => {
      const before = guest.list();
      expect(isOk(before)).toBe(true);
      const beforeTotal = isOk(before) ? before.value.total : -1;

      const created = guest.create({ email: 'ann@example.com', name: 'Ann' });
      expect(isOk(created)).toBe(true);
      if (!isOk(created)) {
        throw new Error('expected create to succeed');
      }
      const id = pkOf(created.value);

      // Success updates the view: the record is reflected on read and the
      // list total grew by exactly one (Req 7.4).
      const read = guest.read(id);
      expect(isOk(read)).toBe(true);
      if (isOk(read)) {
        expect(read.value.email).toBe('ann@example.com');
        expect(read.value.name).toBe('Ann');
      }

      const after = guest.list();
      expect(isOk(after)).toBe(true);
      if (isOk(after)) {
        expect(after.value.total).toBe(beforeTotal + 1);
        expect(after.value.records.map((r) => r['id'])).toContain(id);
      }
    });

    it('rejects an invalid payload, leaving records unchanged with an error (Req 7.5)', () => {
      // An invalid email violates the FORMAT EMAIL constraint.
      const result = guest.create({ email: 'not-an-email', name: 'Bob' });

      expect(isErr(result)).toBe(true);
      if (!isErr(result)) {
        throw new Error('expected create to fail');
      }
      // The error indication identifies the violated constraint (Req 7.5).
      expect(result.error.kind).toBe('VALIDATION_ERROR');
      expect(result.error.violations.some((v) => v.attribute === 'email')).toBe(
        true,
      );

      // Failure persisted nothing: the view is unchanged.
      const after = guest.list();
      expect(isOk(after)).toBe(true);
      if (isOk(after)) {
        expect(after.value.total).toBe(0);
      }
    });

    it('rejects a payload missing a required (NOT_NULL) field without persisting', () => {
      const result = guest.create({ email: 'carol@example.com' });

      expect(isErr(result)).toBe(true);
      if (!isErr(result)) {
        throw new Error('expected create to fail');
      }
      expect(result.error.kind).toBe('VALIDATION_ERROR');
      expect(
        result.error.violations.some(
          (v) => v.attribute === 'name' && v.kind === 'NOT_NULL',
        ),
      ).toBe(true);

      const after = guest.list();
      expect(isOk(after) && after.value.total).toBe(0);
    });
  });

  describe('edit action (Req 7.3, 7.4, 7.5)', () => {
    it('invokes update and reflects the edited record in the view on success', () => {
      const created = guest.create({ email: 'dan@example.com', name: 'Dan' });
      if (!isOk(created)) {
        throw new Error('expected create to succeed');
      }
      const id = pkOf(created.value);

      const updated = guest.update(id, { email: 'dan@example.com', name: 'Daniel' });
      expect(isOk(updated)).toBe(true);

      // Success updates the view: the edit is reflected on read (Req 7.4).
      const read = guest.read(id);
      expect(isOk(read)).toBe(true);
      if (isOk(read)) {
        expect(read.value.name).toBe('Daniel');
      }
    });

    it('returns NOT_FOUND for a non-existent primary key and changes nothing (Req 7.5)', () => {
      const created = guest.create({ email: 'erin@example.com', name: 'Erin' });
      if (!isOk(created)) {
        throw new Error('expected create to succeed');
      }

      const before = guest.list();
      const beforeTotal = isOk(before) ? before.value.total : -1;

      const result = guest.update('00000000-0000-0000-0000-000000000000', {
        email: 'ghost@example.com',
        name: 'Ghost',
      });

      expect(isErr(result)).toBe(true);
      if (isErr(result)) {
        expect(result.error.kind).toBe('NOT_FOUND');
      }

      // The view is unchanged: still the one existing record, untouched.
      const after = guest.list();
      expect(isOk(after) && after.value.total).toBe(beforeTotal);
      const existing = guest.read(pkOf(created.value));
      expect(isOk(existing) && existing.value.name).toBe('Erin');
    });

    it('rejects an edit that violates a constraint, leaving the record unchanged', () => {
      const created = guest.create({ email: 'fay@example.com', name: 'Fay' });
      if (!isOk(created)) {
        throw new Error('expected create to succeed');
      }
      const id = pkOf(created.value);

      const result = guest.update(id, { email: 'bad-email', name: 'Fay' });
      expect(isErr(result)).toBe(true);
      if (isErr(result)) {
        expect(result.error.kind).toBe('VALIDATION_ERROR');
      }

      // The stored record keeps its original, valid values.
      const read = guest.read(id);
      expect(isOk(read)).toBe(true);
      if (isOk(read)) {
        expect(read.value.email).toBe('fay@example.com');
      }
    });
  });

  describe('delete action (Req 7.3, 7.4, 7.5)', () => {
    it('invokes delete and removes the record from the view on success', () => {
      const created = guest.create({ email: 'gus@example.com', name: 'Gus' });
      if (!isOk(created)) {
        throw new Error('expected create to succeed');
      }
      const id = pkOf(created.value);

      const result = guest.delete(id);
      expect(isOk(result)).toBe(true);
      if (isOk(result)) {
        // A deletion confirmation is returned (Req 7.4 / Req 5.5).
        expect(result.value.deleted).toBe(true);
        expect(result.value.entityName).toBe('Guest');
      }

      // Success updates the view: the record is gone on a subsequent read.
      const read = guest.read(id);
      expect(isErr(read)).toBe(true);
      if (isErr(read)) {
        expect(read.error.kind).toBe('NOT_FOUND');
      }
      const after = guest.list();
      expect(isOk(after) && after.value.total).toBe(0);
    });

    it('returns NOT_FOUND when deleting a non-existent record and changes nothing (Req 7.5)', () => {
      const created = guest.create({ email: 'hal@example.com', name: 'Hal' });
      if (!isOk(created)) {
        throw new Error('expected create to succeed');
      }

      const result = guest.delete('11111111-1111-1111-1111-111111111111');
      expect(isErr(result)).toBe(true);
      if (isErr(result)) {
        expect(result.error.kind).toBe('NOT_FOUND');
      }

      // The existing record is untouched.
      const after = guest.list();
      expect(isOk(after) && after.value.total).toBe(1);
    });
  });
});
