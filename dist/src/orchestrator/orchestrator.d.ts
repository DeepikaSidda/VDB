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
import type { DataModel, GenerationJob, GenerationStage, JobInput, MigrationScript } from '../model/types.js';
import { type Result } from '../model/result.js';
/**
 * The entity-count threshold above which the 30-second target is no longer
 * guaranteed (Requirement 9.5). A model is "large" when it has *more than* this
 * many entities, i.e. 11 or more.
 */
export declare const ENTITY_WARNING_THRESHOLD = 10;
/**
 * The fixed message surfaced before starting a Generation_Job whose accepted
 * Data_Model exceeds {@link ENTITY_WARNING_THRESHOLD} entities (Requirement 9.5).
 */
export declare const LARGE_MODEL_NOTICE: string;
/**
 * The soft performance target for a Generation_Job (Requirement 9.1): a job is
 * expected to advance from `SUBMITTED` to `DEPLOYED` within 30 seconds. This is
 * a *target*, not a hard limit — crossing it does not fail the job. It is
 * represented here so the orchestrator can surface/observe a "running over the
 * 30s target" signal (see {@link OrchestratorObserver.onSoftTargetExceeded}).
 */
export declare const SOFT_TARGET_MS = 30000;
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
export declare const HARD_CEILING_MS = 60000;
/**
 * The ordered "happy path" of the Generation_Job state machine. `SUBMITTED` is
 * the entry state and `DEPLOYED` the terminal success state; `FAILED` is a
 * terminal state reachable from any working stage and is therefore not part of
 * this linear sequence.
 */
export declare const STAGE_SEQUENCE: readonly GenerationStage[];
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
/**
 * Return the "30s not guaranteed" notice when the accepted Data_Model has more
 * than {@link ENTITY_WARNING_THRESHOLD} entities, or `null` otherwise
 * (Requirement 9.5 / Property 40). Exposed as a pure function so callers can
 * surface the warning ahead of `run` as well.
 */
export declare function largeModelNotice(model: DataModel): string | null;
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
export declare class Orchestrator {
    private readonly deps;
    private readonly clock;
    private readonly generateId;
    private readonly observer;
    /** In-memory job store keyed by job id. */
    private readonly jobs;
    /**
     * Job ids that have already emitted an {@link OrchestratorObserver.onSoftTargetExceeded}
     * signal, so the 30s soft-target crossing is reported at most once per job.
     */
    private readonly softTargetNotified;
    constructor(deps: OrchestratorDependencies, options?: OrchestratorOptions);
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
    run(input: JobInput): Promise<GenerationJob>;
    /**
     * The most recently entered stage of a job (Requirement 9.2 / Property 38).
     * Throws if the job id is unknown so callers cannot silently observe a
     * non-existent job.
     */
    currentStage(jobId: string): GenerationStage;
    /**
     * The full stored record for a job, or `undefined` if unknown. Lets a UI poll
     * status, model, migration, and failure detail alongside the current stage.
     */
    getJob(jobId: string): GenerationJob | undefined;
    /**
     * Enter a new working stage: mark the job `running`, update `currentStage` so
     * observers immediately see the active stage, and publish the transition.
     */
    private transition;
    /**
     * Record `currentStage` and notify the observer. Updating the stored job
     * first guarantees `currentStage(jobId)` reflects the latest transition even
     * if the observer callback inspects the store synchronously (Property 38).
     */
    private publishStage;
    /** Surface a pre-start notice (e.g. the large-model warning, Requirement 9.5). */
    private publishNotice;
    /**
     * Transition the job to `FAILED`, recording the stage that was active when
     * the error occurred and the component's reason. The active stage is captured
     * from `job.currentStage` before the transition overwrites it.
     */
    private fail;
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
    private runStage;
    /**
     * Race a stage's `work` promise against the job's hard deadline. Resolves
     * with the work's `Result` if it settles first (including rejections, which
     * are flattened to a `PortError` so `run` stays fail-closed), or a `timeout`
     * marker if the wall-clock timer fires first. The timer is derived from the
     * injected clock's notion of remaining time and is always cleared when the
     * work settles, so it never keeps the process alive in tests.
     */
    private raceAgainstDeadline;
    /**
     * Whether the job's elapsed run time has strictly exceeded the hard ceiling
     * (Requirement 9.3 — "exceeds 60 seconds"). Measured against the injected
     * clock.
     */
    private deadlineExceeded;
    /**
     * Emit the 30s soft-target signal once per job, the first time the elapsed
     * run time crosses {@link SOFT_TARGET_MS} (Requirement 9.1). Observational
     * only — it never changes the job's status.
     */
    private maybeNoteSoftTarget;
    /**
     * Halt a job that breached the 60s hard ceiling (Requirement 9.3) and run
     * compensation (Requirement 9.4). The stage active at the breach is captured
     * from `job.currentStage` before the transition to `FAILED` overwrites it and
     * is recorded in the timeout report. Compensation discards any partial
     * artifacts — including any schema already applied to the live target — so no
     * Data_Model is left in `deployed` status; the job itself is set to `failed`,
     * never `deployed`.
     */
    private failTimeout;
    /** Invoke the optional compensation hook, swallowing any error. */
    private compensate;
}
