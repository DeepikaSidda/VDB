/**
 * One-way password hashing for the Auth_Service (Req 6.1).
 *
 * Uses Node's built-in `crypto` scrypt KDF with a per-password random salt, so
 * no native dependency is required. The stored value is `salt:derivedKey`
 * (both hex) and never contains the plaintext password. Verification is
 * constant-time via `timingSafeEqual`.
 */
/**
 * Hash a plaintext password into a one-way `salt:derivedKey` string.
 *
 * A fresh random salt is generated per call, so hashing the same password
 * twice yields different stored values — this is expected and does not affect
 * verification.
 */
export declare function hashPassword(password: string): string;
/**
 * Verify a candidate password against a stored `salt:derivedKey` hash.
 *
 * Returns true only when the candidate, hashed with the stored salt, matches
 * the stored derived key. Returns false for any malformed stored hash rather
 * than throwing.
 */
export declare function verifyPasswordHash(storedHash: string, candidate: string): boolean;
