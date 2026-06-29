/**
 * Property-based tests for the Auth_Service (tasks 8.3–8.8, Req 6.1–6.5, 6.7, 6.8).
 *
 * Framework: vitest + fast-check (min 100 iterations per property, per the
 * design's Testing Strategy). Each property test is tagged exactly:
 *   `Feature: ai-database-architect, Property {n}: {property_text}`
 *
 * Component under test: src/auth/authService.ts `AuthService`.
 *
 * Strategy: every case constructs a fresh `AuthService` with an injected
 * `Map` store, a fixed signing secret, and an injectable clock so the service
 * is fully deterministic. Generators produce non-empty identifiers/passwords
 * and roles drawn from the supported set; mismatch/error scenarios are built
 * by deriving values guaranteed to differ from the stored credentials.
 */

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { AuthService } from '../../src/auth/authService.js';
import type { Role } from '../../src/auth/types.js';
import { isOk, isErr, unwrap } from '../../src/model/result.js';

const NUM_RUNS = 100;
const SECRET = 'test-secret-deterministic';
const MAX_TTL_MS = 24 * 60 * 60 * 1000;
const ROLES: Role[] = ['admin', 'viewer'];

/** Non-empty identifier/password generator. */
const nonEmptyArb = fc.string({ minLength: 1, maxLength: 40 });
const roleArb = fc.constantFrom(...ROLES);

/** Build a fresh service with an injectable mutable clock. */
function freshService(startNow: number, tokenTtlMs?: number) {
  const clock = { now: startNow };
  const service = new AuthService({
    store: new Map(),
    secret: SECRET,
    tokenTtlMs,
    now: () => clock.now,
  });
  return { service, clock };
}

// ---------------------------------------------------------------------------
// Property 27 — Req 6.1
// ---------------------------------------------------------------------------
describe('Auth_Service property 27 (Req 6.1)', () => {
  it('Feature: ai-database-architect, Property 27: Passwords are stored hashed, never plaintext', () => {
    fc.assert(
      fc.property(
        nonEmptyArb,
        nonEmptyArb,
        nonEmptyArb,
        roleArb,
        (identifier, password, otherPassword, role) => {
          const { service } = freshService(1_000_000);
          const result = service.signup(identifier, password, role);
          expect(isOk(result)).toBe(true);
          const account = unwrap(result);

          // Stored credential is not the plaintext password (Req 6.1).
          expect(account.passwordHash).not.toBe(password);
          // Correct password verifies.
          expect(service.verifyPassword(account, password)).toBe(true);
          // Any different password fails to verify.
          if (otherPassword !== password) {
            expect(service.verifyPassword(account, otherPassword)).toBe(false);
          }
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 28 — Req 6.2
// ---------------------------------------------------------------------------
describe('Auth_Service property 28 (Req 6.2)', () => {
  it('Feature: ai-database-architect, Property 28: Valid login issues a bounded-lifetime token', () => {
    fc.assert(
      fc.property(
        nonEmptyArb,
        nonEmptyArb,
        roleArb,
        fc.integer({ min: 0, max: 10_000_000_000 }),
        (identifier, password, role, startNow) => {
          const { service } = freshService(startNow);
          expect(isOk(service.signup(identifier, password, role))).toBe(true);

          const login = service.login(identifier, password);
          expect(isOk(login)).toBe(true);
          const jwt = unwrap(login);

          // Expiry is no later than 24h after issuance (Req 6.2).
          expect(jwt.expiresAt).toBeGreaterThan(startNow);
          expect(jwt.expiresAt).toBeLessThanOrEqual(startNow + MAX_TTL_MS);

          // The issued token validates successfully.
          const auth = service.authorize(jwt.token);
          expect(isOk(auth)).toBe(true);
          expect(unwrap(auth).identifier).toBe(identifier);
          expect(unwrap(auth).role).toBe(role);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 29 — Req 6.3
// ---------------------------------------------------------------------------
describe('Auth_Service property 29 (Req 6.3)', () => {
  it('Feature: ai-database-architect, Property 29: Invalid login issues no token', () => {
    fc.assert(
      fc.property(
        nonEmptyArb,
        nonEmptyArb,
        roleArb,
        fc.boolean(),
        (identifier, password, role, wrongPasswordVariant) => {
          const { service } = freshService(1_000_000);
          expect(isOk(service.signup(identifier, password, role))).toBe(true);

          // Two non-matching shapes: unknown identifier, or wrong password.
          const attempt = wrongPasswordVariant
            ? { id: identifier, pw: `${password}_wrong` } // known id, wrong pw
            : { id: `${identifier}_unknown`, pw: password }; // unknown id

          const login = service.login(attempt.id, attempt.pw);
          expect(isErr(login)).toBe(true);
          if (isErr(login)) {
            expect(login.error.kind).toBe('INVALID_CREDENTIALS');
          }
          // No JWT field present on a rejected login.
          expect('value' in login).toBe(false);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 30 — Req 6.4, 6.5
// ---------------------------------------------------------------------------
describe('Auth_Service property 30 (Req 6.4, 6.5)', () => {
  type Scenario =
    | { kind: 'missing'; tokenIsNull: boolean }
    | { kind: 'malformed'; raw: string }
    | { kind: 'expired' }
    | { kind: 'insufficient' }
    | { kind: 'success'; withRequiredRole: boolean };

  const scenarioArb: fc.Arbitrary<Scenario> = fc.oneof(
    fc.record({ kind: fc.constant('missing' as const), tokenIsNull: fc.boolean() }),
    // A random non-empty string with no embedded NUL; overwhelmingly not a
    // validly-signed 3-segment token, so it resolves to MALFORMED.
    fc.record({
      kind: fc.constant('malformed' as const),
      raw: fc.string({ minLength: 1, maxLength: 60 }),
    }),
    fc.record({ kind: fc.constant('expired' as const) }),
    fc.record({ kind: fc.constant('insufficient' as const) }),
    fc.record({
      kind: fc.constant('success' as const),
      withRequiredRole: fc.boolean(),
    }),
  );

  it('Feature: ai-database-architect, Property 30: Authorization executes only with a valid token and sufficient role', () => {
    fc.assert(
      fc.property(
        nonEmptyArb,
        nonEmptyArb,
        roleArb,
        scenarioArb,
        (identifier, password, role, scenario) => {
          const other: Role = role === 'admin' ? 'viewer' : 'admin';

          if (scenario.kind === 'missing') {
            const { service } = freshService(1_000_000);
            const token = scenario.tokenIsNull ? null : '';
            const res = service.authorize(token, role);
            expect(isErr(res)).toBe(true);
            if (isErr(res)) {
              expect(res.error.kind).toBe('INVALID_TOKEN');
              if (res.error.kind === 'INVALID_TOKEN') {
                expect(res.error.reason).toBe('MISSING');
              }
            }
            return;
          }

          if (scenario.kind === 'malformed') {
            const { service } = freshService(1_000_000);
            const res = service.authorize(scenario.raw, role);
            expect(isErr(res)).toBe(true);
            if (isErr(res)) {
              expect(res.error.kind).toBe('INVALID_TOKEN');
              if (res.error.kind === 'INVALID_TOKEN') {
                // A random string is never present+well-formed+signed, so it
                // is rejected as MALFORMED (not MISSING/EXPIRED).
                expect(res.error.reason).toBe('MALFORMED');
              }
            }
            return;
          }

          if (scenario.kind === 'expired') {
            const { service, clock } = freshService(1_000_000, 1000);
            expect(isOk(service.signup(identifier, password, role))).toBe(true);
            const login = service.login(identifier, password);
            expect(isOk(login)).toBe(true);
            const token = unwrap(login).token;
            // Advance the clock well past the 1s lifetime.
            clock.now += 5000;
            const res = service.authorize(token, role);
            expect(isErr(res)).toBe(true);
            if (isErr(res)) {
              expect(res.error.kind).toBe('INVALID_TOKEN');
              if (res.error.kind === 'INVALID_TOKEN') {
                expect(res.error.reason).toBe('EXPIRED');
              }
            }
            return;
          }

          if (scenario.kind === 'insufficient') {
            const { service } = freshService(1_000_000);
            expect(isOk(service.signup(identifier, password, role))).toBe(true);
            const token = unwrap(service.login(identifier, password)).token;
            // Require the OTHER role, which the account does not hold.
            const res = service.authorize(token, other);
            expect(isErr(res)).toBe(true);
            if (isErr(res)) {
              expect(res.error.kind).toBe('INSUFFICIENT_ROLE');
              if (res.error.kind === 'INSUFFICIENT_ROLE') {
                expect(res.error.required).toBe(other);
              }
            }
            return;
          }

          // scenario.kind === 'success'
          const { service } = freshService(1_000_000);
          expect(isOk(service.signup(identifier, password, role))).toBe(true);
          const token = unwrap(service.login(identifier, password)).token;
          const required = scenario.withRequiredRole ? role : undefined;
          const res = service.authorize(token, required);
          expect(isOk(res)).toBe(true);
          if (isOk(res)) {
            expect(res.value.identifier).toBe(identifier);
            expect(res.value.role).toBe(role);
          }
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 31 — Req 6.7
// ---------------------------------------------------------------------------
describe('Auth_Service property 31 (Req 6.7)', () => {
  it('Feature: ai-database-architect, Property 31: Signup missing a credential is rejected', () => {
    fc.assert(
      fc.property(
        nonEmptyArb,
        // which credential to omit: 0 = identifier, 1 = password, 2 = both
        fc.constantFrom(0, 1, 2),
        (present, omit) => {
          const store = new Map();
          const service = new AuthService({ store, secret: SECRET });

          const identifier = omit === 0 || omit === 2 ? '' : present;
          const password = omit === 1 || omit === 2 ? '' : present;

          const res = service.signup(identifier, password);
          expect(isErr(res)).toBe(true);
          if (isErr(res)) {
            expect(res.error.kind).toBe('MISSING_CREDENTIAL');
            if (res.error.kind === 'MISSING_CREDENTIAL') {
              // The reported missing credential is one that was actually empty.
              if (res.error.credential === 'identifier') {
                expect(identifier).toBe('');
              } else {
                expect(password).toBe('');
              }
            }
          }
          // No account is created.
          expect(store.size).toBe(0);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 32 — Req 6.8
// ---------------------------------------------------------------------------
describe('Auth_Service property 32 (Req 6.8)', () => {
  it('Feature: ai-database-architect, Property 32: Duplicate identifiers are rejected', () => {
    fc.assert(
      fc.property(
        nonEmptyArb,
        nonEmptyArb,
        nonEmptyArb,
        roleArb,
        roleArb,
        (identifier, firstPassword, secondPassword, role1, role2) => {
          const store = new Map();
          const service = new AuthService({ store, secret: SECRET });

          const first = service.signup(identifier, firstPassword, role1);
          expect(isOk(first)).toBe(true);

          // Second signup with the same identifier is rejected as in-use.
          const second = service.signup(identifier, secondPassword, role2);
          expect(isErr(second)).toBe(true);
          if (isErr(second)) {
            expect(second.error.kind).toBe('IDENTIFIER_IN_USE');
          }

          // Exactly one account with that identifier remains, unchanged.
          expect(store.size).toBe(1);
          const stored = store.get(identifier);
          expect(stored).toBeDefined();
          expect(stored.role).toBe(role1);
          // The original credential still verifies (account untouched).
          expect(service.verifyPassword(stored, firstPassword)).toBe(true);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});
