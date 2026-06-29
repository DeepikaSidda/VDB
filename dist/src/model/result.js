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
/** Construct a successful Result. */
export function ok(value) {
    return { ok: true, value };
}
/** Construct a failed Result. */
export function err(error) {
    return { ok: false, error };
}
/** Type guard narrowing a Result to its success branch. */
export function isOk(result) {
    return result.ok;
}
/** Type guard narrowing a Result to its failure branch. */
export function isErr(result) {
    return !result.ok;
}
/**
 * Map the success value of a Result, leaving a failure untouched.
 */
export function mapOk(result, fn) {
    return result.ok ? ok(fn(result.value)) : result;
}
/**
 * Map the error of a Result, leaving a success untouched.
 */
export function mapErr(result, fn) {
    return result.ok ? result : err(fn(result.error));
}
/**
 * Unwrap the success value or throw. Intended for tests and the rare call
 * sites where a failure is genuinely unexpected — production boundaries
 * should branch on `ok` instead.
 */
export function unwrap(result) {
    if (result.ok) {
        return result.value;
    }
    throw new Error(`Called unwrap on an Err Result: ${JSON.stringify(result.error)}`);
}
/**
 * Unwrap the success value or return the provided fallback on failure.
 */
export function unwrapOr(result, fallback) {
    return result.ok ? result.value : fallback;
}
//# sourceMappingURL=result.js.map