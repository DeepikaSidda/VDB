/**
 * Auth_Service types: accounts, roles, tokens, and the typed error union.
 *
 * These are the shared contract between signup/login/token issuance (Task 8.1)
 * and the authorization middleware (Task 8.2). The token/role error variants
 * and `AuthContext` are defined here now so 8.2 can build on the same union
 * without reshaping it.
 *
 * See the design's "Auth_Service" section (Req 6.1–6.8).
 */
/**
 * Roles supported by the Auth_Service. At least two distinct roles must exist
 * with at least one differing permission (Req 6.6). Role/permission
 * enforcement is implemented in Task 8.2; the role set is defined here.
 */
export type Role = 'admin' | 'viewer';
/**
 * A stored user account. The password is held only as a one-way hash
 * (`passwordHash`); the plaintext password is never stored (Req 6.1).
 */
export type UserAccount = {
    /** Unique account identifier (e.g., username or email). */
    identifier: string;
    /**
     * One-way password hash in the form `salt:derivedKey` (both hex). Never the
     * plaintext password (Req 6.1).
     */
    passwordHash: string;
    /** The role granted to the account (Req 6.6). */
    role: Role;
};
/**
 * An issued JSON Web Token plus its absolute expiry. `expiresAt` is epoch
 * milliseconds and is guaranteed to be no later than 24h after issuance
 * (Req 6.2).
 */
export type Jwt = {
    /** The signed token string (`header.payload.signature`, base64url). */
    token: string;
    /** Absolute expiry as epoch milliseconds (≤ issuedAt + 24h, Req 6.2). */
    expiresAt: number;
};
/**
 * The authenticated context resolved from a valid token (Req 6.4/6.5).
 * Produced by `authorize` in Task 8.2.
 */
export type AuthContext = {
    identifier: string;
    role: Role;
};
/**
 * Typed errors returned by the Auth_Service. Discriminated on `kind`.
 *
 * - `MISSING_CREDENTIAL` / `INVALID_CREDENTIALS` / `IDENTIFIER_IN_USE` are used
 *   by signup and login (Task 8.1, Req 6.7/6.3/6.8).
 * - `INVALID_TOKEN` / `INSUFFICIENT_ROLE` are reserved for the authorization
 *   middleware (Task 8.2, Req 6.4/6.5).
 */
export type AuthError = {
    kind: 'MISSING_CREDENTIAL';
    credential: 'identifier' | 'password';
} | {
    kind: 'INVALID_CREDENTIALS';
} | {
    kind: 'IDENTIFIER_IN_USE';
    identifier: string;
} | {
    kind: 'INVALID_TOKEN';
    reason: 'MISSING' | 'MALFORMED' | 'EXPIRED';
} | {
    kind: 'INSUFFICIENT_ROLE';
    required: Role;
};
