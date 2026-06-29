import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import {
  ok,
  err,
  isOk,
  isErr,
  mapOk,
  mapErr,
  unwrap,
  unwrapOr,
  type Result,
} from '../../src/model/result.js';

/**
 * Tooling verification: confirms the test runner (vitest) and the
 * property-based testing library (fast-check) are wired up, and exercises
 * the shared `Result<T, E>` type used across all component boundaries.
 */
describe('Result<T, E>', () => {
  it('constructs and narrows a success Result', () => {
    const r = ok(42);
    expect(isOk(r)).toBe(true);
    expect(isErr(r)).toBe(false);
    if (isOk(r)) {
      expect(r.value).toBe(42);
    }
  });

  it('constructs and narrows a failure Result', () => {
    const r = err('boom');
    expect(isErr(r)).toBe(true);
    expect(isOk(r)).toBe(false);
    if (isErr(r)) {
      expect(r.error).toBe('boom');
    }
  });

  it('unwrap returns the value on success and throws on failure', () => {
    expect(unwrap(ok('hello'))).toBe('hello');
    expect(() => unwrap(err('nope'))).toThrow();
  });

  it('unwrapOr returns the fallback on failure', () => {
    const success: Result<number, string> = ok(1);
    const failure: Result<number, string> = err('e');
    expect(unwrapOr(success, 99)).toBe(1);
    expect(unwrapOr(failure, 99)).toBe(99);
  });

  // fast-check property: mapOk over a success equals fn(value); mapErr leaves
  // a success untouched. Minimum 100 runs (fast-check default is 100).
  it('mapOk transforms success values and preserves failures', () => {
    fc.assert(
      fc.property(fc.integer(), (n) => {
        const success = mapOk(ok(n), (x) => x + 1);
        expect(isOk(success) && success.value === n + 1).toBe(true);

        const failure = mapOk(err<string>('e'), (x: number) => x + 1);
        expect(isErr(failure)).toBe(true);
      }),
      { numRuns: 100 },
    );
  });

  it('mapErr transforms errors and preserves successes', () => {
    fc.assert(
      fc.property(fc.string(), (s) => {
        const failure = mapErr(err(s), (e) => `wrapped:${e}`);
        expect(isErr(failure) && failure.error === `wrapped:${s}`).toBe(true);

        const success = mapErr(ok(1), (e: string) => `wrapped:${e}`);
        expect(isOk(success)).toBe(true);
      }),
      { numRuns: 100 },
    );
  });
});
