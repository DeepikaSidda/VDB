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
import { err, isErr } from '../model/result.js';
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
export const LARGE_MODEL_NOTICE = 'The accepted data model has more than 10 entities; completion within the ' +
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
export const STAGE_SEQUENCE = [
    'SUBMITTED',
    'MODELING',
    'REFINING',
    'SCHEMA_GEN',
    'VERIFYING',
    'DEPLOYING',
    'API_GEN',
    'DEPLOYED',
];
// ---------------------------------------------------------------------------
// Notice helper (Requirement 9.5)
// ---------------------------------------------------------------------------
/**
 * Return the "30s not guaranteed" notice when the accepted Data_Model has more
 * than {@link ENTITY_WARNING_THRESHOLD} entities, or `null` otherwise
 * (Requirement 9.5 / Property 40). Exposed as a pure function so callers can
 * surface the warning ahead of `run` as well.
 */
export function largeModelNotice(model) {
    return model.entities.length > ENTITY_WARNING_THRESHOLD
        ? LARGE_MODEL_NOTICE
        : null;
}
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
    deps;
    clock;
    generateId;
    observer;
    /** In-memory job store keyed by job id. */
    jobs = new Map();
    /**
     * Job ids that have already emitted an {@link OrchestratorObserver.onSoftTargetExceeded}
     * signal, so the 30s soft-target crossing is reported at most once per job.
     */
    softTargetNotified = new Set();
    constructor(deps, options = {}) {
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
    async run(input) {
        const job = {
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
        if (modeled.kind === 'timeout')
            return this.failTimeout(job);
        if (modeled.kind === 'error')
            return this.fail(job, modeled.error);
        // --- REFINING -----------------------------------------------------------
        this.transition(job, 'REFINING');
        const refined = await this.runStage(job, () => this.deps.refinement.refine(modeled.value));
        if (refined.kind === 'timeout')
            return this.failTimeout(job);
        if (refined.kind === 'error')
            return this.fail(job, refined.error);
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
        const generated = await this.runStage(job, () => this.deps.schemaGenerator.generate(acceptedModel));
        if (generated.kind === 'timeout')
            return this.failTimeout(job);
        if (generated.kind === 'error')
            return this.fail(job, generated.error);
        job.migration = generated.value;
        // --- VERIFYING (deploy gate) -------------------------------------------
        this.transition(job, 'VERIFYING');
        const verified = await this.runStage(job, () => this.deps.verifier.verify(generated.value, acceptedModel));
        if (verified.kind === 'timeout')
            return this.failTimeout(job);
        if (verified.kind === 'error')
            return this.fail(job, verified.error);
        // --- DEPLOYING ----------------------------------------------------------
        this.transition(job, 'DEPLOYING');
        const deployed = await this.runStage(job, () => this.deps.provisioner.apply(generated.value));
        if (deployed.kind === 'timeout')
            return this.failTimeout(job);
        if (deployed.kind === 'error')
            return this.fail(job, deployed.error);
        // --- API_GEN ------------------------------------------------------------
        this.transition(job, 'API_GEN');
        const apis = await this.runStage(job, () => this.deps.apiGenerator.generate(acceptedModel));
        if (apis.kind === 'timeout')
            return this.failTimeout(job);
        if (apis.kind === 'error')
            return this.fail(job, apis.error);
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
    currentStage(jobId) {
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
    getJob(jobId) {
        return this.jobs.get(jobId);
    }
    // -------------------------------------------------------------------------
    // Internal helpers
    // -------------------------------------------------------------------------
    /**
     * Enter a new working stage: mark the job `running`, update `currentStage` so
     * observers immediately see the active stage, and publish the transition.
     */
    transition(job, stage) {
        job.status = 'running';
        this.publishStage(job, stage);
    }
    /**
     * Record `currentStage` and notify the observer. Updating the stored job
     * first guarantees `currentStage(jobId)` reflects the latest transition even
     * if the observer callback inspects the store synchronously (Property 38).
     */
    publishStage(job, stage) {
        job.currentStage = stage;
        this.observer?.onStageTransition?.({
            jobId: job.id,
            stage,
            at: this.clock(),
        });
    }
    /** Surface a pre-start notice (e.g. the large-model warning, Requirement 9.5). */
    publishNotice(job, message) {
        this.observer?.onNotice?.({ jobId: job.id, message, at: this.clock() });
    }
    /**
     * Transition the job to `FAILED`, recording the stage that was active when
     * the error occurred and the component's reason. The active stage is captured
     * from `job.currentStage` before the transition overwrites it.
     */
    fail(job, error) {
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
    async runStage(job, work) {
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
    raceAgainstDeadline(job, work) {
        const remaining = job.startedAt + HARD_CEILING_MS - this.clock();
        // Normalize a rejected stage into a fail-closed PortError result.
        const settled = work.then((value) => value, (reason) => err({ message: messageOf(reason), detail: reason }));
        // If no time remains, skip the real timer entirely; the caller's boundary
        // check after the work settles handles the breach.
        if (remaining <= 0) {
            return settled.then((value) => ({ kind: 'work', value }));
        }
        return new Promise((resolve) => {
            const timer = setTimeout(() => {
                resolve({ kind: 'timeout' });
            }, remaining);
            // Don't let the safety-net timer keep the event loop alive on its own.
            if (typeof timer.unref === 'function') {
                timer.unref();
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
    deadlineExceeded(job) {
        return this.clock() - job.startedAt > HARD_CEILING_MS;
    }
    /**
     * Emit the 30s soft-target signal once per job, the first time the elapsed
     * run time crosses {@link SOFT_TARGET_MS} (Requirement 9.1). Observational
     * only — it never changes the job's status.
     */
    maybeNoteSoftTarget(job) {
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
    async failTimeout(job) {
        const activeStage = job.currentStage;
        // Compensation first: discard partial artifacts so nothing is left deployed
        // (Requirement 9.4). Best-effort — a compensation failure must not mask the
        // timeout outcome.
        await this.compensate(job);
        job.status = 'failed';
        job.failure = {
            stage: activeStage,
            reason: `Generation_Job exceeded the ${HARD_CEILING_MS}ms hard timeout while ` +
                `the ${activeStage} stage was active`,
        };
        this.publishStage(job, 'FAILED');
        return job;
    }
    /** Invoke the optional compensation hook, swallowing any error. */
    async compensate(job) {
        try {
            await this.deps.compensation?.compensate(job);
        }
        catch {
            // Best-effort: compensation failure must not mask the timeout outcome.
        }
    }
}
/**
 * Extract a human-readable message from an unknown thrown value, so a stage
 * that rejects can be reported as a fail-closed {@link PortError}.
 */
function messageOf(reason) {
    if (reason instanceof Error) {
        return reason.message;
    }
    return String(reason);
}
//# sourceMappingURL=orchestrator.js.map