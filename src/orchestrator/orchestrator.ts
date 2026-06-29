/**
 * The Generation_Job Orchestrator: the state machine that drives a single
 * end-to-end run from `SUBMITTED` to `DEPLOYED`, wiring each stage to its
 * component and publishing the active stage so the UI can poll/stream it
 * (Requirement 9.2). It also surfaces a "30s not guaranteed" notice before
 * generation starts when the accepted Data_Model has more than 10 entities
 * (Requirement 9.5).
 *
 * Scope (tasks 11.1 + 11.2): state machine + stage publishing + the
 * >10-entity notice (11.1), plus 30s soft-target observation and 60s
 * hard-timeout enforcement with compensation (11.2). A controllable `clock` is
 * injected so the timeout path can be driven deterministically (Property 39).
 *
 * Dependency injection: each stage is wired to a component through a minimal
 * local *port* interface (see Ports below). The real Modeling_Engine,
 * Refinement_Engine, Schema_Generator, Round-Trip Verifier, Provisioner, and
 * API_Generator are built in parallel and adapted onto these ports by task
 * 12.1; defining narrow ports here lets 11.1 stand alone and compile.
 */

import { randomUUID } from 'node:crypto';
import type {
  DataModel,
  GenerationJob,
  GenerationStage,
  JobInput,
  MigrationScript,
} from '../model/types.js';
import { type Result, err, isErr } from '../model/result.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * The entity-count threshold above which the 30-second target is no longer
 * guaranteed (Requirement 9.5). A model is "large" when it has *more than* this
 * many entities, i.e. 11 or more.
 */
export const ENTITY_WARNING_THRESHOLD = 10;

/**
 * The fixed message surfaced before starting a Generation_Job whose accepted
 * Data_Model exceeds {@link ENTITY_WARNING_THRESHOLD} entities (Requirement 9.5).
 */
export const LARGE_MODEL_NOTICE =
  'The accepted data model has more than 10 entities; completion within the ' +
  '30-second target is not guaranteed.';

/**
 * The soft performance target for a Generation_Job (Requirement 9.1): a job is
 * expected to advance from `SUBMITTED` to `DEPLOYED` within 30 seconds. This is
 * a *target*, not a hard limit — crossing it does not fail the job. It is
 * represented here so the orchestrator can surface/observe a "running over the
 * 30s target" signal (see {@link OrchestratorObserver.onSoftTargetExceeded}).
 */
export const SOFT_TARGET_MS = 30_000;

/**
 * The hard ceiling for a Generation_Job (Requirement 9.3): if a job's elapsed
 * run time exceeds 60 seconds before reaching `DEPLOYED`, the job is halted,
 * set to `FAILED` with the stage active at the 60s mark recorded in the timeout
 * report, and compensation runs to discard any partial artifacts (Requirement
 * 9.4). Unlike {@link SOFT_TARGET_MS}, breaching this ceiling fails the job.
 *
 * Elapsed time is measured against the injected {@link Clock}, so the ceiling
 * is deterministically testable: a controllable clock can be advanced past it
 * to drive the timeout path (Property 39).
 */
export const HARD_CEILING_MS = 60_000;

/**
 * The ordered "happy path" of the Generation_Job state machine. `SUBMITTED` is
 * the entry state and `DEPLOYED` the terminal success state; `FAILED` is a
 * terminal state reachable from any working stage and is therefore not part of
 * this linear sequence.
 */
export const STAGE_SEQUENCE: readonly GenerationStage[] = [
  'SUBMITTED',
  'MODELING',
  'REFINING',
  'SCHEMA_GEN',
  'VERIFYING',
  'DEPLOYING',
  'API_GEN',
  'DEPLOYED',
] as const;

// ---------------------------------------------------------------------------
// Dependency ports
// ---------------------------------------------------------------------------

/**
 * The uniform error shape returned by every stage component through the ports
 * below. The orchestrator only needs a human-readable reason to record on the
 * job's `failure`, so concrete component error taxonomies are flattened to a
 * `message` (and an optional `detail`) by the adapters that task 12.1 writes.
 */
export type PortError = {
  message: string;
  detail?: unknown;
};

/** A stage component result: async and fail-closed via `Result`. */
export type PortResult<T> = Promise<Result<T, PortError>>;

/**
 * MODELING stage port — backed by the Modeling_Engine. Turns the job input
 * into an initial Data_Model (Requirement 1).
 */
export interface ModelingPort {
  infer(input: JobInput): PortResult<DataModel>;
}

/**
 * REFINING stage port — backed by the Refinement_Engine. Produces the
 * *accepted* Data_Model (after clarifying questions are answered or skipped).
 * In the absence of interactive answers this returns the model unchanged
 * (Requirement 8.6).
 */
export interface RefinementPort {
  refine(model: DataModel): PortResult<DataModel>;
}

/**
 * SCHEMA_GEN stage port — backed by the Schema_Generator. Projects the accepted
 * Data_Model into an ordered migration script (Requirement 3).
 */
export interface SchemaGeneratorPort {
  generate(model: DataModel): PortResult<MigrationScript>;
}

/**
 * VERIFYING stage port — backed by the Round-Trip Verifier (the deploy gate).
 * Confirms the generated DDL round-trips to the source model (Requirement 12).
 */
export interface RoundTripVerifierPort {
  verify(migration: MigrationScript, source: DataModel): PortResult<void>;
}

/**
 * DEPLOYING stage port — backed by the Provisioner. Applies the verified
 * migration to the live target (Requirement 4).
 */
export interface ProvisionerPort {
  apply(migration: MigrationScript): PortResult<void>;
}

/**
 * API_GEN stage port — backed by the API_Generator (and auth/dashboard
 * descriptor generation). Produces the live API surface (Requirement 5).
 */
export interface ApiGeneratorPort {
  generate(model: DataModel): PortResult<void>;
}

/**
 * Compensation port (Requirement 9.4). Invoked when a Generation_Job is halted
 * by the 60s hard timeout to discard any partially created artifacts — most
 * importantly any schema the Provisioner already applied to the live target —
 * so that no Data_Model is left in `deployed` status.
 *
 * The orchestrator treats compensation as best-effort and idempotent: it is
 * called on timeout regardless of which stage was active, and a failure inside
 * compensation must not mask the timeout outcome. Task 12.1 adapts this onto
 * the Provisioner's teardown/rollback when wiring the real pipeline; until then
 * it is optional so the orchestrator stands alone and compiles.
 */
export interface CompensationPort {
  /** Discard any partial artifacts associated with the timed-out job. */
  compensate(job: GenerationJob): Promise<void>;
}

/**
 * The full set of stage components the orchestrator drives, injected at
 * construction. Each is adapted onto its narrow port by task 12.1.
 */
export interface OrchestratorDependencies {
  modeling: ModelingPort;
  refinement: RefinementPort;
  schemaGenerator: SchemaGeneratorPort;
  verifier: RoundTripVerifierPort;
  provisioner: ProvisionerPort;
  apiGenerator: ApiGeneratorPort;
  /**
   * Optional teardown invoked on a hard-timeout to discard partial artifacts
   * (Requirement 9.4). When omitted, a timeout still fails the job closed; the
   * hook is the seam through which deployed schema is rolled back once the real
   * Provisioner is wired in (task 12.1).
   */
  compensation?: CompensationPort;
}

// ---------------------------------------------------------------------------
// Observability
// ---------------------------------------------------------------------------

/**
 * A monotonic clock injected so timeouts (task 11.2) and timing-sensitive
 * tests (Property 39) can be driven deterministically. Returns milliseconds.
 */
export type Clock = () => number;

/**
 * Observer hooks the UI layer (or tests) can supply to react to job progress.
 * `onStageTransition` fires on *every* stage change — including the move to
 * `DEPLOYED` or `FAILED` — so a UI can reflect the current stage within the
 * 2-second budget of Requirement 9.2. `onNotice` fires once, before stage work
 * begins, for the large-model warning (Requirement 9.5).
 */
export interface OrchestratorObserver {
  onStageTransition?: (event: StageTransitionEvent) => void;
  onNotice?: (event: NoticeEvent) => void;
  /**
   * Fires once per job, the first time its elapsed run time crosses the 30s
   * soft target (Requirement 9.1) without yet having finished. This is an
   * observational signal only — it does not fail the job (that is the role of
   * the 60s hard ceiling, Requirement 9.3) — and lets a UI surface a "running
   * longer than the 30s target" indication.
   */
  onSoftTargetExceeded?: (event: SoftTargetEvent) => void;
}

/** Published whenever a job's `currentStage` changes. */
export type StageTransitionEvent = {
  jobId: string;
  stage: GenerationStage;
  at: number;
};

/** Published when a pre-start notice is surfaced (e.g. the large-model warning). */
export type NoticeEvent = {
  jobId: string;
  message: string;
  at: number;
};

/**
 * Published the first time a running job crosses the 30s soft target
 * (Requirement 9.1). Carries the stage active at the moment the target was
 * crossed so a UI can show where the time is being spent.
 */
export type SoftTargetEvent = {
  jobId: string;
  stage: GenerationStage;
  at: number;
};

/**
 * Options accepted by the orchestrator. All are optional: a default real-time
 * `clock`, an id generator, and an observer can be supplied independently.
 */
export interface OrchestratorOptions {
  clock?: Clock;
  generateId?: () => string;
  observer?: OrchestratorObserver;
}

// ---------------------------------------------------------------------------
// Notice helper (Requirement 9.5)
// ---------------------------------------------------------------------------

/**
 * Return the "30s not guaranteed" notice when the accepted Data_Model has more
 * than {@link ENTITY_WARNING_THRESHOLD} entities, or `null` otherwise
 * (Requirement 9.5 / Property 40). Exposed as a pure function so callers can
 * surface the warning ahead of `run` as well.
 */
export function largeModelNotice(model: DataModel): string | null {
  return model.entities.length > ENTITY_WARNING_THRESHOLD
    ? LARGE_MODEL_NOTICE
    : null;
}

// ---------------------------------------------------------------------------
// Stage outcome
// ---------------------------------------------------------------------------

/**
 * The result of running a single stage under the hard-timeout guard. A stage
 * can finish successfully (`ok`), fail with a component error (`error`), or be
 * cut short because the 60s hard ceiling was breached (`timeout`). The three
 * cases are kept distinct so `run` can route a timeout through compensation
 * (Requirement 9.4) while ordinary errors take the normal fail path.
 */
type StageOutcome<T> =
  | { kind: 'ok'; value: T }
  | { kind: 'error'; error: PortError }
  | { kind: 'timeout' };

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

/**
 * Drives the Generation_Job state machine and owns the in-memory job store.
 *
 * Stage publishing model (Requirement 9.2): the orchestrator updates the
 * stored job's `currentStage` *before* invoking each stage's component, so
 * `currentStage(jobId)` always reflects the most recently entered stage — i.e.
 * the stage whose component is currently executing (Property 38). Each update
 * is pushed to the injected observer so a UI can poll the store or subscribe to
 * transitions.
 */
export class Orchestrator {
  private readonly deps: OrchestratorDependencies;
  private readonly clock: Clock;
  private readonly generateId: () => string;
  private readonly observer: OrchestratorObserver | undefined;

  /** In-memory job store keyed by job id. */
  private readonly jobs = new Map<string, GenerationJob>();

  /**
   * Job ids that have already emitted an {@link OrchestratorObserver.onSoftTargetExceeded}
   * signal, so the 30s soft-target crossing is reported at most once per job.
   */
  private readonly softTargetNotified = new Set<string>();

  constructor(deps: OrchestratorDependencies, options: OrchestratorOptions = {}) {
    this.deps = deps;
    this.clock = options.clock ?? Date.now;
    this.generateId = options.generateId ?? (() => randomUUID());
    this.observer = options.observer;
  }

  /**
   * Run a Generation_Job to completion, advancing through
   * SUBMITTED → MODELING → REFINING → SCHEMA_GEN → VERIFYING → DEPLOYING →
   * API_GEN → DEPLOYED. On any component error the job transitions to `FAILED`
   * with the active stage recorded in `failure.stage` (Requirement 9.3's
   * "active stage" semantics are reused here for ordinary failures). The
   * resolved `GenerationJob` is the final stored record.
   *
   * The accepted model (post-REFINING) is checked against the large-model
   * threshold and, if it exceeds it, the "30s not guaranteed" notice is
   * surfaced before any schema/deploy work begins (Requirement 9.5).
   *
   * Timeout (Requirements 9.3, 9.4): every stage runs under a hard-ceiling
   * guard ({@link HARD_CEILING_MS}). If the job's elapsed run time exceeds the
   * ceiling before reaching `DEPLOYED`, the job halts, transitions to `FAILED`
   * with the stage that was active at the breach recorded in the timeout
   * report, and compensation runs to discard any partial artifacts so no
   * Data_Model is left in `deployed` status. Elapsed time is measured against
   * the injected {@link Clock}, so the timeout path is deterministically
   * testable (Property 39).
   */
  async run(input: JobInput): Promise<GenerationJob> {
    const job: GenerationJob = {
      id: this.generateId(),
      input,
      currentStage: 'SUBMITTED',
      status: 'submitted',
      startedAt: this.clock(),
    };
    this.jobs.set(job.id, job);
    this.publishStage(job, 'SUBMITTED');

    // --- MODELING -----------------------------------------------------------
    this.transition(job, 'MODELING');
    const modeled = await this.runStage(job, () => this.deps.modeling.infer(input));
    if (modeled.kind === 'timeout') return this.failTimeout(job);
    if (modeled.kind === 'error') return this.fail(job, modeled.error);

    // --- REFINING -----------------------------------------------------------
    this.transition(job, 'REFINING');
    const refined = await this.runStage(job, () =>
      this.deps.refinement.refine(modeled.value),
    );
    if (refined.kind === 'timeout') return this.failTimeout(job);
    if (refined.kind === 'error') return this.fail(job, refined.error);

    // The accepted model is the output of refinement. Record it on the job and
    // surface the large-model notice *before* schema/deploy work begins.
    const acceptedModel = refined.value;
    job.model = acceptedModel;
    const notice = largeModelNotice(acceptedModel);
    if (notice !== null) {
      this.publishNotice(job, notice);
    }

    // --- SCHEMA_GEN ---------------------------------------------------------
    this.transition(job, 'SCHEMA_GEN');
    const generated = await this.runStage(job, () =>
      this.deps.schemaGenerator.generate(acceptedModel),
    );
    if (generated.kind === 'timeout') return this.failTimeout(job);
    if (generated.kind === 'error') return this.fail(job, generated.error);
    job.migration = generated.value;

    // --- VERIFYING (deploy gate) -------------------------------------------
    this.transition(job, 'VERIFYING');
    const verified = await this.runStage(job, () =>
      this.deps.verifier.verify(generated.value, acceptedModel),
    );
    if (verified.kind === 'timeout') return this.failTimeout(job);
    if (verified.kind === 'error') return this.fail(job, verified.error);

    // --- DEPLOYING ----------------------------------------------------------
    this.transition(job, 'DEPLOYING');
    const deployed = await this.runStage(job, () =>
      this.deps.provisioner.apply(generated.value),
    );
    if (deployed.kind === 'timeout') return this.failTimeout(job);
    if (deployed.kind === 'error') return this.fail(job, deployed.error);

    // --- API_GEN ------------------------------------------------------------
    this.transition(job, 'API_GEN');
    const apis = await this.runStage(job, () =>
      this.deps.apiGenerator.generate(acceptedModel),
    );
    if (apis.kind === 'timeout') return this.failTimeout(job);
    if (apis.kind === 'error') return this.fail(job, apis.error);

    // --- DEPLOYED (terminal success) ---------------------------------------
    // Publish the terminal stage first, then mark the job deployed: a plain
    // `transition` resets status to `running`, so the deployed status is set
    // last to survive as the job's final, terminal status (Req 4.2, 9.1).
    this.transition(job, 'DEPLOYED');
    job.status = 'deployed';
    return job;
  }

  /**
   * The most recently entered stage of a job (Requirement 9.2 / Property 38).
   * Throws if the job id is unknown so callers cannot silently observe a
   * non-existent job.
   */
  currentStage(jobId: string): GenerationStage {
    const job = this.jobs.get(jobId);
    if (job === undefined) {
      throw new Error(`Unknown Generation_Job id: ${jobId}`);
    }
    return job.currentStage;
  }

  /**
   * The full stored record for a job, or `undefined` if unknown. Lets a UI poll
   * status, model, migration, and failure detail alongside the current stage.
   */
  getJob(jobId: string): GenerationJob | undefined {
    return this.jobs.get(jobId);
  }

  // -------------------------------------------------------------------------
  // Internal helpers
  // -------------------------------------------------------------------------

  /**
   * Enter a new working stage: mark the job `running`, update `currentStage` so
   * observers immediately see the active stage, and publish the transition.
   */
  private transition(job: GenerationJob, stage: GenerationStage): void {
    job.status = 'running';
    this.publishStage(job, stage);
  }

  /**
   * Record `currentStage` and notify the observer. Updating the stored job
   * first guarantees `currentStage(jobId)` reflects the latest transition even
   * if the observer callback inspects the store synchronously (Property 38).
   */
  private publishStage(job: GenerationJob, stage: GenerationStage): void {
    job.currentStage = stage;
    this.observer?.onStageTransition?.({
      jobId: job.id,
      stage,
      at: this.clock(),
    });
  }

  /** Surface a pre-start notice (e.g. the large-model warning, Requirement 9.5). */
  private publishNotice(job: GenerationJob, message: string): void {
    this.observer?.onNotice?.({ jobId: job.id, message, at: this.clock() });
  }

  /**
   * Transition the job to `FAILED`, recording the stage that was active when
   * the error occurred and the component's reason. The active stage is captured
   * from `job.currentStage` before the transition overwrites it.
   */
  private fail(job: GenerationJob, error: PortError): GenerationJob {
    const activeStage = job.currentStage;
    job.status = 'failed';
    job.failure = { stage: activeStage, reason: error.message };
    this.publishStage(job, 'FAILED');
    return job;
  }

  // -------------------------------------------------------------------------
  // Timeout enforcement & compensation (Requirements 9.1, 9.3, 9.4)
  // -------------------------------------------------------------------------

  /**
   * Run one stage's component under the 60s hard-ceiling guard.
   *
   * Two complementary mechanisms enforce the ceiling, both anchored to the
   * injected {@link Clock} so the timeout is deterministic:
   *
   * 1. **Boundary checks (clock-driven).** The deadline is checked before the
   *    stage starts and again once its work resolves. A stage whose own work
   *    advances the clock past the ceiling (the model Property 39 drives with a
   *    controllable clock) is detected here, and the breach is attributed to
   *    that stage because `job.currentStage` still names it.
   * 2. **A real-time race (wall-clock safety net).** The work is raced against
   *    a timer sized to the remaining time so a genuinely hung async stage
   *    under the default real clock still times out rather than blocking
   *    forever. The timer is cleared as soon as the work settles.
   */
  private async runStage<T>(
    job: GenerationJob,
    work: () => PortResult<T>,
  ): Promise<StageOutcome<T>> {
    // Already past the ceiling before this stage's work even begins.
    if (this.deadlineExceeded(job)) {
      return { kind: 'timeout' };
    }
    this.maybeNoteSoftTarget(job);

    const raced = await this.raceAgainstDeadline(job, work());
    if (raced.kind === 'timeout') {
      return { kind: 'timeout' };
    }

    // The work settled. Re-check in case the stage's own work advanced the
    // clock past the ceiling (the deterministic, controllable-clock path).
    if (this.deadlineExceeded(job)) {
      return { kind: 'timeout' };
    }
    this.maybeNoteSoftTarget(job);

    const result = raced.value;
    if (isErr(result)) {
      return { kind: 'error', error: result.error };
    }
    return { kind: 'ok', value: result.value };
  }

  /**
   * Race a stage's `work` promise against the job's hard deadline. Resolves
   * with the work's `Result` if it settles first (including rejections, which
   * are flattened to a `PortError` so `run` stays fail-closed), or a `timeout`
   * marker if the wall-clock timer fires first. The timer is derived from the
   * injected clock's notion of remaining time and is always cleared when the
   * work settles, so it never keeps the process alive in tests.
   */
  private raceAgainstDeadline<T>(
    job: GenerationJob,
    work: PortResult<T>,
  ): Promise<{ kind: 'work'; value: Result<T, PortError> } | { kind: 'timeout' }> {
    const remaining = job.startedAt + HARD_CEILING_MS - this.clock();

    // Normalize a rejected stage into a fail-closed PortError result.
    const settled: PortResult<T> = work.then(
      (value) => value,
      (reason) => err<PortError>({ message: messageOf(reason), detail: reason }),
    );

    // If no time remains, skip the real timer entirely; the caller's boundary
    // check after the work settles handles the breach.
    if (remaining <= 0) {
      return settled.then((value) => ({ kind: 'work', value }) as const);
    }

    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        resolve({ kind: 'timeout' });
      }, remaining);
      // Don't let the safety-net timer keep the event loop alive on its own.
      if (typeof (timer as { unref?: () => void }).unref === 'function') {
        (timer as { unref: () => void }).unref();
      }
      void settled.then((value) => {
        clearTimeout(timer);
        resolve({ kind: 'work', value });
      });
    });
  }

  /**
   * Whether the job's elapsed run time has strictly exceeded the hard ceiling
   * (Requirement 9.3 — "exceeds 60 seconds"). Measured against the injected
   * clock.
   */
  private deadlineExceeded(job: GenerationJob): boolean {
    return this.clock() - job.startedAt > HARD_CEILING_MS;
  }

  /**
   * Emit the 30s soft-target signal once per job, the first time the elapsed
   * run time crosses {@link SOFT_TARGET_MS} (Requirement 9.1). Observational
   * only — it never changes the job's status.
   */
  private maybeNoteSoftTarget(job: GenerationJob): void {
    if (this.softTargetNotified.has(job.id)) {
      return;
    }
    if (this.clock() - job.startedAt > SOFT_TARGET_MS) {
      this.softTargetNotified.add(job.id);
      this.observer?.onSoftTargetExceeded?.({
        jobId: job.id,
        stage: job.currentStage,
        at: this.clock(),
      });
    }
  }

  /**
   * Halt a job that breached the 60s hard ceiling (Requirement 9.3) and run
   * compensation (Requirement 9.4). The stage active at the breach is captured
   * from `job.currentStage` before the transition to `FAILED` overwrites it and
   * is recorded in the timeout report. Compensation discards any partial
   * artifacts — including any schema already applied to the live target — so no
   * Data_Model is left in `deployed` status; the job itself is set to `failed`,
   * never `deployed`.
   */
  private async failTimeout(job: GenerationJob): Promise<GenerationJob> {
    const activeStage = job.currentStage;

    // Compensation first: discard partial artifacts so nothing is left deployed
    // (Requirement 9.4). Best-effort — a compensation failure must not mask the
    // timeout outcome.
    await this.compensate(job);

    job.status = 'failed';
    job.failure = {
      stage: activeStage,
      reason:
        `Generation_Job exceeded the ${HARD_CEILING_MS}ms hard timeout while ` +
        `the ${activeStage} stage was active`,
    };
    this.publishStage(job, 'FAILED');
    return job;
  }

  /** Invoke the optional compensation hook, swallowing any error. */
  private async compensate(job: GenerationJob): Promise<void> {
    try {
      await this.deps.compensation?.compensate(job);
    } catch {
      // Best-effort: compensation failure must not mask the timeout outcome.
    }
  }
}

/**
 * Extract a human-readable message from an unknown thrown value, so a stage
 * that rejects can be reported as a fail-closed {@link PortError}.
 */
function messageOf(reason: unknown): string {
  if (reason instanceof Error) {
    return reason.message;
  }
  return String(reason);
}
