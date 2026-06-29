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
export type Ok<T> = {
    readonly ok: true;
    readonly value: T;
};
export type Err<E> = {
    readonly ok: false;
    readonly error: E;
};
export type Result<T, E> = Ok<T> | Err<E>;
/** Construct a successful Result. */
export declare function ok<T>(value: T): Ok<T>;
/** Construct a failed Result. */
export declare function err<E>(error: E): Err<E>;
/** Type guard narrowing a Result to its success branch. */
export declare function isOk<T, E>(result: Result<T, E>): result is Ok<T>;
/** Type guard narrowing a Result to its failure branch. */
export declare function isErr<T, E>(result: Result<T, E>): result is Err<E>;
/**
 * Map the success value of a Result, leaving a failure untouched.
 */
export declare function mapOk<T, U, E>(result: Result<T, E>, fn: (value: T) => U): Result<U, E>;
/**
 * Map the error of a Result, leaving a success untouched.
 */
export declare function mapErr<T, E, F>(result: Result<T, E>, fn: (error: E) => F): Result<T, F>;
/**
 * Unwrap the success value or throw. Intended for tests and the rare call
 * sites where a failure is genuinely unexpected — production boundaries
 * should branch on `ok` instead.
 */
export declare function unwrap<T, E>(result: Result<T, E>): T;
/**
 * Unwrap the success value or return the provided fallback on failure.
 */
export declare function unwrapOr<T, E>(result: Result<T, E>, fallback: T): T;
