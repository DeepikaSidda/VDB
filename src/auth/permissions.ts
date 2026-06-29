/**
 * Role → permission model for the Auth_Service (Req 6.6).
 *
 * The Auth_Service supports at least two distinct roles whose permission sets
 * differ by at least one permission. Permissions are modeled explicitly so the
 * difference is verifiable (e.g., by the role-configuration smoke test, Task
 * 8.9): `admin` holds the full CRUD set while `viewer` is a strict subset
 * (read only). This guarantees at least one permission (`CREATE`, for example)
 * is held by one role and not the other.
 *
 * Role-based authorization in `authorize` (Task 8.2) decides sufficiency by
 * role identity; this permission model is the associated, inspectable
 * representation that satisfies Req 6.6.
 */

import type { Role } from './types.js';

/**
 * The set of permissions a role may hold. Mirrors the generated CRUD surface
 * (create/read/update/delete) so role policy maps directly onto API actions.
 */
export type Permission = 'CREATE' | 'READ' | 'UPDATE' | 'DELETE';

/**
 * Permission set per role (Req 6.6).
 *
 * - `admin`: full CRUD — create, read, update, delete.
 * - `viewer`: read only — a strict subset of `admin`.
 *
 * At least one permission (`CREATE`/`UPDATE`/`DELETE`) is held by `admin` and
 * not by `viewer`, satisfying "at least one permission differs between the two
 * roles".
 */
export const ROLE_PERMISSIONS: Readonly<Record<Role, readonly Permission[]>> = {
  admin: ['CREATE', 'READ', 'UPDATE', 'DELETE'],
  viewer: ['READ'],
} as const;

/**
 * Whether a role holds a given permission (Req 6.6). Used by callers that
 * enforce per-action access against a resolved {@link Role}.
 */
export function hasPermission(role: Role, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role].includes(permission);
}
