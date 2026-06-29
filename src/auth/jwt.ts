/**
 * Minimal signed-token (JWT) utility for the Auth_Service.
 *
 * Implements a real HMAC-SHA256 signed token (`header.payload.signature`,
 * base64url) using Node's built-in `crypto`, avoiding an external JWT
 * dependency. The signing secret is injectable. Token issuance lives in
 * Task 8.1; the verification path is reused by `authorize` in Task 8.2, so
 * `verifyToken` is provided here as the shared helper.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

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

const HEADER = { alg: 'HS256', typ: 'JWT' } as const;

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url');
}

function sign(signingInput: string, secret: string): string {
  return createHmac('sha256', secret).update(signingInput).digest('base64url');
}

/**
 * Sign a set of claims into a `header.payload.signature` token string.
 */
export function signToken(claims: JwtClaims, secret: string): string {
  const encodedHeader = base64url(JSON.stringify(HEADER));
  const encodedPayload = base64url(JSON.stringify(claims));
  const signingInput = `${encodedHeader}.${encodedPayload}`;
  const signature = sign(signingInput, secret);
  return `${signingInput}.${signature}`;
}

/**
 * The outcome of verifying a token. Reused by the authorization middleware
 * (Task 8.2): a `MALFORMED`/`EXPIRED` reason maps to an `INVALID_TOKEN` error.
 */
export type VerifyTokenResult =
  | { ok: true; claims: JwtClaims }
  | { ok: false; reason: 'MALFORMED' | 'EXPIRED' };

/**
 * Verify a token's signature and expiry against the signing secret.
 *
 * @param now epoch milliseconds used for the expiry check (injectable clock).
 */
export function verifyToken(
  token: string,
  secret: string,
  now: number,
): VerifyTokenResult {
  const segments = token.split('.');
  if (segments.length !== 3) {
    return { ok: false, reason: 'MALFORMED' };
  }
  const [encodedHeader, encodedPayload, signature] = segments;
  if (!encodedHeader || !encodedPayload || !signature) {
    return { ok: false, reason: 'MALFORMED' };
  }

  const expectedSignature = sign(`${encodedHeader}.${encodedPayload}`, secret);
  const provided = Buffer.from(signature);
  const expected = Buffer.from(expectedSignature);
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
    return { ok: false, reason: 'MALFORMED' };
  }

  let claims: JwtClaims;
  try {
    claims = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8')) as JwtClaims;
  } catch {
    return { ok: false, reason: 'MALFORMED' };
  }
  if (
    typeof claims.sub !== 'string' ||
    typeof claims.role !== 'string' ||
    typeof claims.iat !== 'number' ||
    typeof claims.exp !== 'number'
  ) {
    return { ok: false, reason: 'MALFORMED' };
  }

  if (now >= claims.exp * 1000) {
    return { ok: false, reason: 'EXPIRED' };
  }

  return { ok: true, claims };
}
