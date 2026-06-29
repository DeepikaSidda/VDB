/**
 * Task 12.4 — integration test for end-to-end generation timing.
 *
 * Verifies the two timing guarantees a small-model Generation_Job must meet:
 *  - it advances from SUBMITTED all the way to DEPLOYED within the 30s soft
 *    target (Req 9.1);
 *  - stage updates are published, in order, with each transition reported
 *    within 2 seconds of the prior one so a UI can reflect the active stage
 *    within the 2s budget (Req 9.2).
 *
 * Determinism: the orchestrator reads time from an injected `clock`. We drive
 * it with a monotonic stepping clock (100ms per call) so the elapsed-time and
 * inter-transition assertions are exact and never flaky. A second test runs the
 * same job under the real wall clock to confirm a small model genuinely
 * completes well under 30 seconds in practice.
 */

import { describe, it, expect } from 'vitest';
import { createStubPipeline } from '../../src/pipeline/pipeline.js';
import type { RawCandidateModel } from '../../src/modeling/llmClient.js';
import type { GenerationStage, JobInput } from '../../src/model/types.js';
import {
  SOFT_TARGET_MS,
  STAGE_SEQUENCE,
  type Clock,
  type StageTransitionEvent,
} from '../../src/orchestrator/orchestrator.js';

/** A small two-entity model — comfortably under the >10-entity warning bound. */
const SMALL_CANDIDATE: RawCandidateModel = {
  entities: [
    {
      name: 'Guest',
      attributes: [
        { name: 'email', dataType: 'TEXT', unique: true, required: true },
        { name: 'name', dataType: 'TEXT', required: true },
      ],
    },
    {
      name: 'Booking',
      attributes: [{ name: 'nights', dataType: 'INTEGER', required: true }],
    },
  ],
  relationships: [
    { source: 'Booking', target: 'Guest', cardinality: 'one-to-many' },
  ],
};

const PROMPT: JobInput = {
  kind: 'PROMPT',
  prompt: 'Build a small hotel booking backend',
};

/** Per-transition reporting budget (Req 9.2): a UI must see updates within 2s. */
const TRANSITION_BUDGET_MS = 2_000;

/**
 * A deterministic monotonic clock that advances by `stepMs` on every read. The
 * first read returns 0 (the job's `startedAt`), and each subsequent read is
 * `stepMs` later, so the orchestrator's many time reads across a run accumulate
 * a small, predictable elapsed time — far under the 30s target while keeping
 * each inter-transition gap well under the 2s budget.
 */
function steppingClock(stepMs: number): Clock {
  let now = 0;
  return () => {
    const current = now;
    now += stepMs;
    return current;
  };
}

describe('Task 12.4 — end-to-end generation timing', () => {
  it('advances submitted → deployed within 30s with in-order, ≤2s-apart stage updates', async () => {
    const transitions: StageTransitionEvent[] = [];
    const clock = steppingClock(100);

    const pipeline = createStubPipeline(SMALL_CANDIDATE, {
      clock,
      observer: {
        onStageTransition: (event) => transitions.push(event),
      },
    });

    const { job } = await pipeline.run(PROMPT);

    // Reached the terminal success state (Req 9.1).
    expect(job.status).toBe('deployed');
    expect(job.currentStage).toBe('DEPLOYED');

    // The full happy-path sequence was observed, in order (Req 9.2).
    const observedStages = transitions.map((t) => t.stage);
    expect(observedStages).toEqual([...STAGE_SEQUENCE]);

    const firstAt = transitions[0].at;
    const lastAt = transitions[transitions.length - 1].at;

    // Submitted → deployed completed within the 30s soft target (Req 9.1).
    // `startedAt` is the clock's first read (0); the DEPLOYED transition is the
    // last observed event.
    expect(job.startedAt).toBe(0);
    expect(lastAt - job.startedAt).toBeLessThanOrEqual(SOFT_TARGET_MS);

    // Each stage transition is reported within 2s of the prior one (Req 9.2),
    // and timestamps are monotonically non-decreasing.
    for (let i = 1; i < transitions.length; i += 1) {
      const gap = transitions[i].at - transitions[i - 1].at;
      expect(gap).toBeGreaterThanOrEqual(0);
      expect(gap).toBeLessThanOrEqual(TRANSITION_BUDGET_MS);
    }

    // The first (SUBMITTED) transition is reported within the budget of the
    // job's start time too.
    expect(firstAt - job.startedAt).toBeLessThanOrEqual(TRANSITION_BUDGET_MS);

    // Sanity: every event belongs to this one job.
    const jobIds = new Set(transitions.map((t) => t.jobId));
    expect(jobIds).toEqual(new Set([job.id]));
  });

  it('completes a small model well under 30s on the real wall clock', async () => {
    const transitions: GenerationStage[] = [];
    const pipeline = createStubPipeline(SMALL_CANDIDATE, {
      observer: {
        onStageTransition: (event) => transitions.push(event.stage),
      },
    });

    const startedAt = Date.now();
    const { job } = await pipeline.run(PROMPT);
    const elapsed = Date.now() - startedAt;

    expect(job.status).toBe('deployed');
    expect(transitions).toEqual([...STAGE_SEQUENCE]);
    // A small stub-backed run is effectively instantaneous; assert it is
    // comfortably inside the 30s target rather than asserting an exact time.
    expect(elapsed).toBeLessThan(SOFT_TARGET_MS);
  });
});
