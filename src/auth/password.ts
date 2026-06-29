/**
 * One-way password hashing for the Auth_Service (Req 6.1).
 *
 * Uses Node's built-in `crypto` scrypt KDF with a per-password random salt, so
 * no native dependency is required. The stored value is `salt:derivedKey`
 * (both hex) and never contains the plaintext password. Verification is
 * constant-time via `timingSafeEqual`.
 */

import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

/** Length of the random salt in bytes. */
const SALT_BYTES = 16;
/** Length of the derived key in bytes. */
const KEY_BYTES = 64;

/**
 * Hash a plaintext password into a one-way `salt:derivedKey` string.
 *
 * A fresh random salt is generated per call, so hashing the same password
 * twice yields different stored values — this is expected and does not affect
 * verification.
 */
export function hashPassword(password: string): string {
  const salt = randomBytes(SALT_BYTES);
  const derived = scryptSync(password, salt, KEY_BYTES);
  return `${salt.toString('hex')}:${derived.toString('hex')}`;
}

/**
 * Verify a candidate password against a stored `salt:derivedKey` hash.
 *
 * Returns true only when the candidate, hashed with the stored salt, matches
 * the stored derived key. Returns false for any malformed stored hash rather
 * than throwing.
 */
export function verifyPasswordHash(storedHash: string, candidate: string): boolean {
  const parts = storedHash.split(':');
  if (parts.length !== 2) {
    return false;
  }
  const [saltHex, keyHex] = parts;
  if (!saltHex || !keyHex) {
    return false;
  }

  let salt: Buffer;
  let expected: Buffer;
  try {
    salt = Buffer.from(saltHex, 'hex');
    expected = Buffer.from(keyHex, 'hex');
  } catch {
    return false;
  }
  if (salt.length === 0 || expected.length === 0) {
    return false;
  }

  const actual = scryptSync(candidate, salt, expected.length);
  // Lengths are equal by construction (derived to `expected.length`), so
  // timingSafeEqual is safe to call directly.
  return timingSafeEqual(actual, expected);
}
