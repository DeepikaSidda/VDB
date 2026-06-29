/**
 * Role-configuration smoke test for the Auth_Service (task 8.9, Req 6.6).
 *
 * Verifies the system ships at least two distinct roles whose permission sets
 * differ by at least one permission. This is a concrete, example-based smoke
 * test (not a property) per the design's Testing Strategy.
 *
 * Component under test: src/auth/permissions.ts (ROLE_PERMISSIONS, hasPermission).
 */

import { describe, it, expect } from 'vitest';
import { ROLE_PERMISSIONS, hasPermission } from '../../src/auth/permissions.js';
import type { Permission } from '../../src/auth/permissions.js';
import type { Role } from '../../src/auth/types.js';

describe('Auth_Service roles smoke test (Req 6.6)', () => {
  const roles = Object.keys(ROLE_PERMISSIONS) as Role[];

  it('defines at least two distinct roles', () => {
    expect(roles.length).toBeGreaterThanOrEqual(2);
    expect(new Set(roles).size).toBe(roles.length);
  });

  it('has at least two roles with differing permission sets', () => {
    const permSets = roles.map((r) => new Set<Permission>(ROLE_PERMISSIONS[r]));

    // There exists at least one pair of roles whose permission sets differ.
    let foundDifferingPair = false;
    for (let i = 0; i < permSets.length; i++) {
      for (let j = i + 1; j < permSets.length; j++) {
        const a = permSets[i];
        const b = permSets[j];
        const same =
          a.size === b.size && [...a].every((p) => b.has(p));
        if (!same) {
          foundDifferingPair = true;
        }
      }
    }
    expect(foundDifferingPair).toBe(true);
  });

  it('admin and viewer differ by at least one concrete permission', () => {
    // admin holds CREATE; viewer does not — a concrete differing permission.
    expect(hasPermission('admin', 'CREATE')).toBe(true);
    expect(hasPermission('viewer', 'CREATE')).toBe(false);

    // Both share READ, confirming the difference is partial, not total.
    expect(hasPermission('admin', 'READ')).toBe(true);
    expect(hasPermission('viewer', 'READ')).toBe(true);
  });

  it('hasPermission is consistent with the declared ROLE_PERMISSIONS table', () => {
    const all: Permission[] = ['CREATE', 'READ', 'UPDATE', 'DELETE'];
    for (const role of roles) {
      for (const perm of all) {
        expect(hasPermission(role, perm)).toBe(
          ROLE_PERMISSIONS[role].includes(perm),
        );
      }
    }
  });
});
