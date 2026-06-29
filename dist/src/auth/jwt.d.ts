/**
 * Minimal signed-token (JWT) utility for the Auth_Service.
 *
 * Implements a real HMAC-SHA256 signed token (`header.payload.signature`,
 * base64url) using Node's built-in `crypto`, avoiding an external JWT
 * dependency. The signing secret is injectable. Token issuance lives in
 * Task 8.1; the verification path is reused by `authorize` in Task 8.2, so
 * `verifyToken` is provided here as the shared helper.
 */
/** Standard JWT claims emitted by this utility. */
export type JwtClaims = {
    /** Subject — the account identifier. */
    sub: string;
    /** Role granted to the subject. */
    role: string;
    /** Issued-at, epoch seconds. */
    iat: number;
    /** Expiry, epoch seconds. */
    exp: number;
};
/**
 * Sign a set of claims into a `header.payload.signature` token string.
 */
export declare function signToken(claims: JwtClaims, secret: string): string;
/**
 * The outcome of verifying a token. Reused by the authorization middleware
 * (Task 8.2): a `MALFORMED`/`EXPIRED` reason maps to an `INVALID_TOKEN` error.
 */
export type VerifyTokenResult = {
    ok: true;
    claims: JwtClaims;
} | {
    ok: false;
    reason: 'MALFORMED' | 'EXPIRED';
};
/**
 * Verify a token's signature and expiry against the signing secret.
 *
 * @param now epoch milliseconds used for the expiry check (injectable clock).
 */
export declare function verifyToken(token: string, secret: string, now: number): VerifyTokenResult;
