/**
 * Auth_Service — signup, login, and JWT issuance (Task 8.1, Req 6.1–6.3, 6.7, 6.8).
 *
 * Passwords are stored only as one-way hashes (Req 6.1). Signup rejects missing
 * credentials (Req 6.7) and duplicate identifiers (Req 6.8), creating no account
 * in either case. Login issues a JWT expiring no later than 24h after issuance
 * (Req 6.2) for matching credentials, and rejects non-matching credentials
 * without issuing any token (Req 6.3).
 *
 * The account store and signing secret are injectable so the service is
 * deterministic and testable. The `authorize` middleware and role enforcement
 * (Req 6.4/6.5/6.6, Task 8.2) reuse the shared verify helper (`./jwt`), the
 * full `AuthError` union (`./types`), and the role → permission model
 * (`./permissions`).
 */
import { err, ok } from '../model/result.js';
import { hashPassword, verifyPasswordHash } from './password.js';
import { signToken, verifyToken } from './jwt.js';
/** 24 hours in milliseconds — the maximum token lifetime (Req 6.2). */
const MAX_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;
/** Default signing secret used when none is injected (override in production). */
const DEFAULT_SECRET = 'dev-insecure-secret-override-me';
/**
 * Provides signup, login, and token issuance over a deterministic in-memory
 * account store.
 */
export class AuthService {
    store;
    secret;
    tokenTtlMs;
    now;
    constructor(options = {}) {
        this.store = options.store ?? new Map();
        this.secret = options.secret ?? DEFAULT_SECRET;
        // Clamp to ≤ 24h so an issued token can never outlive the Req 6.2 bound.
        const requestedTtl = options.tokenTtlMs ?? MAX_TOKEN_TTL_MS;
        this.tokenTtlMs = Math.min(Math.max(requestedTtl, 1), MAX_TOKEN_TTL_MS);
        this.now = options.now ?? (() => Date.now());
    }
    /**
     * Create a user account, storing a one-way password hash (Req 6.1).
     *
     * Rejects with `MISSING_CREDENTIAL` when the identifier or password is
     * missing/empty, creating no account (Req 6.7). Rejects with
     * `IDENTIFIER_IN_USE` when the identifier already exists, creating no
     * duplicate (Req 6.8).
     *
     * @param role role to grant; defaults to `viewer` (Req 6.6).
     */
    signup(identifier, password, role = 'viewer') {
        // Req 6.7: missing identifier or password — reject, create nothing.
        if (typeof identifier !== 'string' || identifier.length === 0) {
            return err({ kind: 'MISSING_CREDENTIAL', credential: 'identifier' });
        }
        if (typeof password !== 'string' || password.length === 0) {
            return err({ kind: 'MISSING_CREDENTIAL', credential: 'password' });
        }
        // Req 6.8: duplicate identifier — reject, create no duplicate.
        if (this.store.has(identifier)) {
            return err({ kind: 'IDENTIFIER_IN_USE', identifier });
        }
        // Req 6.1: store a one-way hash, never the plaintext.
        const account = {
            identifier,
            passwordHash: hashPassword(password),
            role,
        };
        this.store.set(identifier, account);
        return ok(account);
    }
    /**
     * Authenticate credentials and, on a match, issue a JWT expiring ≤ 24h after
     * issuance (Req 6.2). Non-matching credentials are rejected with
     * `INVALID_CREDENTIALS` and no token is issued (Req 6.3).
     */
    login(identifier, password) {
        const account = this.store.get(identifier);
        // Req 6.3: unknown identifier or wrong password is invalid credentials —
        // no token is issued in either case.
        if (account === undefined || !verifyPasswordHash(account.passwordHash, password)) {
            return err({ kind: 'INVALID_CREDENTIALS' });
        }
        // Req 6.2: bounded-lifetime token (≤ 24h).
        const issuedAtMs = this.now();
        const expiresAt = issuedAtMs + this.tokenTtlMs;
        const token = signToken({
            sub: account.identifier,
            role: account.role,
            iat: Math.floor(issuedAtMs / 1000),
            exp: Math.floor(expiresAt / 1000),
        }, this.secret);
        return ok({ token, expiresAt });
    }
    /**
     * Verify a candidate password against a stored account. Exposed as a reusable
     * helper for callers that already hold the account.
     */
    verifyPassword(account, password) {
        return verifyPasswordHash(account.passwordHash, password);
    }
    /**
     * Authorization middleware (Req 6.4/6.5). The requested operation executes
     * only when the token is present, well-formed, unexpired, AND the resolved
     * role satisfies `requiredRole`. On any failure an `AuthError` is returned
     * and the caller must NOT execute the operation.
     *
     * - Missing/empty token → `INVALID_TOKEN` reason `MISSING` (Req 6.4).
     * - Malformed/expired token → `INVALID_TOKEN` reason `MALFORMED`/`EXPIRED`
     *   (Req 6.4), mapped from the shared {@link verifyToken} helper.
     * - Valid token but role does not satisfy `requiredRole` → `INSUFFICIENT_ROLE`
     *   (Req 6.5).
     * - Valid token + sufficient role (or no `requiredRole`) → an
     *   {@link AuthContext} of `{ identifier, role }`.
     *
     * Role sufficiency is decided by role identity: a token's role satisfies a
     * required role only when they are equal. The associated role → permission
     * model lives in `./permissions` (Req 6.6).
     *
     * @param token the bearer token (or null/undefined when absent).
     * @param requiredRole the role the endpoint requires; when omitted, any
     *   valid token is sufficient.
     */
    authorize(token, requiredRole) {
        // Req 6.4: a missing or empty token is rejected; nothing executes.
        if (typeof token !== 'string' || token.length === 0) {
            return err({ kind: 'INVALID_TOKEN', reason: 'MISSING' });
        }
        // Req 6.4: malformed or expired tokens are rejected; nothing executes.
        const verification = verifyToken(token, this.secret, this.now());
        if (!verification.ok) {
            return err({ kind: 'INVALID_TOKEN', reason: verification.reason });
        }
        const role = verification.claims.role;
        // Req 6.5: a valid token whose role does not satisfy the required role is
        // rejected with insufficient permissions; nothing executes.
        if (requiredRole !== undefined && role !== requiredRole) {
            return err({ kind: 'INSUFFICIENT_ROLE', required: requiredRole });
        }
        // Valid token + sufficient role (or no role required): resolve the context.
        return ok({ identifier: verification.claims.sub, role });
    }
}
//# sourceMappingURL=authService.js.map