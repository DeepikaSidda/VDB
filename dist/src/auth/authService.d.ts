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
import { type Result } from '../model/result.js';
import type { AuthContext, AuthError, Jwt, Role, UserAccount } from './types.js';
/**
 * Options for constructing an {@link AuthService}. All are optional; defaults
 * make the service usable out of the box while remaining injectable for tests.
 */
export type AuthServiceOptions = {
    /** Injectable in-memory account store keyed by identifier. */
    store?: Map<string, UserAccount>;
    /** Injectable HMAC signing secret for issued tokens. */
    secret?: string;
    /**
     * Token lifetime in milliseconds. Clamped to ≤ 24h to guarantee Req 6.2.
     * Defaults to 24h.
     */
    tokenTtlMs?: number;
    /** Injectable clock returning epoch milliseconds (defaults to Date.now). */
    now?: () => number;
};
/**
 * Provides signup, login, and token issuance over a deterministic in-memory
 * account store.
 */
export declare class AuthService {
    private readonly store;
    private readonly secret;
    private readonly tokenTtlMs;
    private readonly now;
    constructor(options?: AuthServiceOptions);
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
    signup(identifier: string, password: string, role?: Role): Result<UserAccount, AuthError>;
    /**
     * Authenticate credentials and, on a match, issue a JWT expiring ≤ 24h after
     * issuance (Req 6.2). Non-matching credentials are rejected with
     * `INVALID_CREDENTIALS` and no token is issued (Req 6.3).
     */
    login(identifier: string, password: string): Result<Jwt, AuthError>;
    /**
     * Verify a candidate password against a stored account. Exposed as a reusable
     * helper for callers that already hold the account.
     */
    verifyPassword(account: UserAccount, password: string): boolean;
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
    authorize(token: string | null | undefined, requiredRole?: Role): Result<AuthContext, AuthError>;
}
