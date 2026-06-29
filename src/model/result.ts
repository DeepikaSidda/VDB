/**
 * Shared `Result<T, E>` type used across all component boundaries.
 *
 * The system follows a uniform fail-closed, typed-error discipline: every
 * component returns a `Result<T, E>` rather than throwing across boundaries.
 * See the design's "Error Handling" section.
 *
 * Conventions:
 * - A successful outcome is `{ ok: true, value: T }`.
 * - A failure outcome is `{ ok: false, error: E }`.
 * - No error path may leave partial artifacts; callers must inspect `ok`
 *   before accessing `value`.
 */

export type Ok<T> = { readonly ok: true; readonly value: T };
export type Err<E> = { readonly ok: false; readonly error: E };

export type Result<T, E> = Ok<T> | Err<E>;

/** Construct a successful Result. */
export function ok<T>(value: T): Ok<T> {
  return { ok: true, value };
}

/** Construct a failed Result. */
export function err<E>(error: E): Err<E> {
  return { ok: false, error };
}

/** Type guard narrowing a Result to its success branch. */
export function isOk<T, E>(result: Result<T, E>): result is Ok<T> {
  return result.ok;
}

/** Type guard narrowing a Result to its failure branch. */
export function isErr<T, E>(result: Result<T, E>): result is Err<E> {
  return !result.ok;
}

/**
 * Map the success value of a Result, leaving a failure untouched.
 */
export function mapOk<T, U, E>(
  result: Result<T, E>,
  fn: (value: T) => U,
): Result<U, E> {
  return result.ok ? ok(fn(result.value)) : result;
}

/**
 * Map the error of a Result, leaving a success untouched.
 */
export function mapErr<T, E, F>(
  result: Result<T, E>,
  fn: (error: E) => F,
): Result<T, F> {
  return result.ok ? result : err(fn(result.error));
}

/**
 * Unwrap the success value or throw. Intended for tests and the rare call
 * sites where a failure is genuinely unexpected — production boundaries
 * should branch on `ok` instead.
 */
export function unwrap<T, E>(result: Result<T, E>): T {
  if (result.ok) {
    return result.value;
  }
  throw new Error(
    `Called unwrap on an Err Result: ${JSON.stringify(result.error)}`,
  );
}

/**
 * Unwrap the success value or return the provided fallback on failure.
 */
export function unwrapOr<T, E>(result: Result<T, E>, fallback: T): T {
  return result.ok ? result.value : fallback;
}
