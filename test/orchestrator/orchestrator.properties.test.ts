/**
 * Property-based tests for the Generation_Job Orchestrator (tasks 11.3–11.5).
 *
 * These exercise the orchestration state machine, its hard-timeout safety net,
 * and the large-model pre-start notice across a wide input space. The real
 * stage components are replaced with minimal deterministic stub ports so the
 * orchestration logic itself is what is under test. A controllable clock is
 * injected wherever timing matters so the timeout path is exercised without
 * any real waiting.
 *
 * Properties covered (design.md, Orchestration Properties):
 *   - Property 38: Reported stage reflects the latest transition (Req 9.2)
 *   - Property 39: Timeout safety                              (Req 9.3, 9.4)
 *   - Property 40: Large-model warning boundary                (Req 9.5)
 */

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import type {
  DataModel,
  GenerationStage,
  JobInput,
  MigrationScript,
} from '../../src/model/types.js';
import { ok } from '../../src/model/result.js';
import {
  Orchestrator,
  STAGE_SEQUENCE,
  HARD_CEILING_MS,
  LARGE_MODEL_NOTICE,
  largeModelNotice,
  type CompensationPort,
  type NoticeEvent,
  type OrchestratorDependencies,
  type StageTransitionEvent,
} from '../../src/orchestrator/orchestrator.js';

const NUM_RUNS = 100;

// ---------------------------------------------------------------------------
// Fixtures & helpers
// ---------------------------------------------------------------------------

/** Build a minimal, structurally valid Data_Model with `count` entities. */
function buildModel(count: number): DataModel {
  return {
    entities: Array.from({ length: count }, (_, i) => ({
      name: `E${i}`,
      attributes: [
        { name: 'id', dataType: 'UUID' as const, constraints: [{ kind: 'PRIMARY_KEY' as const }] },
      ],
      primaryKey: ['id'],
      isJoinEntity: false,
    })),
    relationships: [],
  };
}

/** A minimal migration script the schema-gen stub can hand downstream. */
const MIGRATION: MigrationScript = {
  target: 'POSTGRES',
  statements: [{ sql: 'CREATE TABLE e ();', kind: 'CREATE_TABLE' }],
};

/** Arbitrary Generation_Job input across the supported kinds. */
const jobInputArb: fc.Arbitrary<JobInput> = fc.oneof(
  fc.record({ kind: fc.constant('PROMPT' as const), prompt: fc.string({ minLength: 1 }) }),
  fc.record({
    kind: fc.constant('DOCUMENT' as const),
    document: fc.record({
      name: fc.constant('data.csv'),
      content: fc.string({ minLength: 1 }),
    }),
  }),
);

/** The working stages a timeout can be attributed to (excludes the terminals). */
const WORKING_STAGES = [
  'MODELING',
  'REFINING',
  'SCHEMA_GEN',
  'VERIFYING',
  'DEPLOYING',
  'API_GEN',
] as const satisfies readonly GenerationStage[];

/**
 * Build a full set of stub ports backed by a constant model. Every stage
 * succeeds with `ok`, so under a non-advancing clock a run reaches DEPLOYED.
 */
function happyDeps(model: DataModel): OrchestratorDependencies {
  return {
    modeling: { infer: async () => ok(model) },
    refinement: { refine: async (m) => ok(m) },
    schemaGenerator: { generate: async () => ok(MIGRATION) },
    verifier: { verify: async () => ok(undefined) },
    provisioner: { apply: async () => ok(undefined) },
    apiGenerator: { generate: async () => ok(undefined) },
  };
}

// ---------------------------------------------------------------------------
// Property 38
// ---------------------------------------------------------------------------

describe('Feature: ai-database-architect, Property 38: Reported stage reflects the latest transition', () => {
  // *For any* sequence of stage transitions applied to a Generation_Job, the
  // job's reported current stage always equals the most recently applied stage.
  //
  // **Validates: Requirements 9.2**
  it('the stored current stage equals the most recently emitted stage at every transition and after run', async () => {
    await fc.assert(
      fc.asyncProperty(jobInputArb, fc.integer({ min: 1, max: 8 }), async (input, entityCount) => {
        const model = buildModel(entityCount);

        const emitted: GenerationStage[] = [];
        let latest: GenerationStage | undefined;
        // Declared up front so the observer closure can read the live store.
        let orchestrator!: Orchestrator;

        orchestrator = new Orchestrator(happyDeps(model), {
          // Constant clock: elapsed time is always 0, so no timeout interferes.
          clock: () => 0,
          observer: {
            onStageTransition: (event: StageTransitionEvent) => {
              // The store must already reflect the just-applied transition.
              expect(orchestrator.getJob(event.jobId)?.currentStage).toBe(event.stage);
              emitted.push(event.stage);
              latest = event.stage;
            },
          },
        });

        const job = await orchestrator.run(input);

        // The reported stage always equals the most recently applied stage.
        expect(orchestrator.currentStage(job.id)).toBe(latest);
        expect(job.currentStage).toBe(latest);
        // A successful run walks exactly the happy-path sequence in order.
        expect(emitted).toEqual([...STAGE_SEQUENCE]);
        expect(latest).toBe('DEPLOYED');
        expect(job.status).toBe('deployed');
      }),
      { numRuns: NUM_RUNS },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 39
// ---------------------------------------------------------------------------

describe('Feature: ai-database-architect, Property 39: Timeout safety', () => {
  // *For any* generation stage active when the 60-second ceiling is reached
  // (driven by a controllable clock), the Generation_Job transitions to failed
  // status, the reported timeout identifies that active stage, and no partially
  // deployed artifact remains in deployed status afterward.
  //
  // **Validates: Requirements 9.3, 9.4**
  it('breaching the hard ceiling in any stage fails the job, names that stage, and leaves nothing deployed', async () => {
    await fc.assert(
      fc.asyncProperty(fc.constantFrom(...WORKING_STAGES), async (breachStage) => {
        const clock = { now: 0 };
        const state = { deployed: false, compensateCalls: 0 };
        const model = buildModel(1);

        // The chosen stage advances the clock past the ceiling during its own
        // work; the orchestrator's post-work boundary check then attributes the
        // breach to whichever stage is currently active.
        const breach = (stage: GenerationStage) => {
          if (stage === breachStage) {
            clock.now = HARD_CEILING_MS + 1;
          }
        };

        const compensation: CompensationPort = {
          compensate: async () => {
            state.compensateCalls += 1;
            state.deployed = false; // discard any partially deployed artifact
          },
        };

        const deps: OrchestratorDependencies = {
          modeling: { infer: async () => { breach('MODELING'); return ok(model); } },
          refinement: { refine: async (m) => { breach('REFINING'); return ok(m); } },
          schemaGenerator: { generate: async () => { breach('SCHEMA_GEN'); return ok(MIGRATION); } },
          verifier: { verify: async () => { breach('VERIFYING'); return ok(undefined); } },
          provisioner: {
            apply: async () => {
              state.deployed = true; // schema applied to the live target
              breach('DEPLOYING');
              return ok(undefined);
            },
          },
          apiGenerator: { generate: async () => { breach('API_GEN'); return ok(undefined); } },
          compensation,
        };

        const orchestrator = new Orchestrator(deps, { clock: () => clock.now });
        const job = await orchestrator.run({ kind: 'PROMPT', prompt: 'shop' });

        // Transitions to failed status, never deployed.
        expect(job.status).toBe('failed');
        expect(job.status).not.toBe('deployed');
        expect(job.currentStage).toBe('FAILED');

        // The reported timeout identifies the active stage at the breach.
        expect(job.failure).toBeDefined();
        expect(job.failure?.stage).toBe(breachStage);
        expect(job.failure?.reason).toContain(breachStage);

        // No partially deployed artifact remains; compensation ran (Req 9.4).
        expect(state.deployed).toBe(false);
        expect(state.compensateCalls).toBeGreaterThanOrEqual(1);
      }),
      { numRuns: NUM_RUNS },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 40
// ---------------------------------------------------------------------------

describe('Feature: ai-database-architect, Property 40: Large-model warning boundary', () => {
  // *For any* accepted Data_Model, a pre-start "30 seconds not guaranteed"
  // notice is emitted if and only if the model contains more than 10 entities.
  //
  // **Validates: Requirements 9.5**
  it('a run emits the large-model notice iff the accepted model has more than 10 entities', async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 0, max: 25 }), async (entityCount) => {
        const model = buildModel(entityCount);
        const notices: NoticeEvent[] = [];

        const orchestrator = new Orchestrator(happyDeps(model), {
          clock: () => 0,
          observer: { onNotice: (event) => notices.push(event) },
        });

        await orchestrator.run({ kind: 'PROMPT', prompt: 'domain' });

        if (entityCount > 10) {
          expect(notices).toHaveLength(1);
          expect(notices[0].message).toBe(LARGE_MODEL_NOTICE);
        } else {
          expect(notices).toHaveLength(0);
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('largeModelNotice returns the notice iff the model has more than 10 entities', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 50 }), (entityCount) => {
        const notice = largeModelNotice(buildModel(entityCount));
        expect(notice).toBe(entityCount > 10 ? LARGE_MODEL_NOTICE : null);
      }),
      { numRuns: NUM_RUNS },
    );
  });
});
