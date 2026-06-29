/**
 * GenerationPipeline — the [MUST] vertical-slice wiring (task 12.1).
 *
 * This module connects the real components of the backend engine onto the
 * {@link Orchestrator}'s narrow stage *ports* and exposes a single high-level
 * entry, {@link GenerationPipeline.run}, that drives one input all the way to a
 * live backend + dashboard descriptor:
 *
 *   Modeling_Engine -> Refinement_Engine -> Schema_Generator
 *     -> Round-Trip Verifier (deploy gate) -> Provisioner
 *     -> API_Generator / Auth / Dashboard
 *
 * Design principle: the Orchestrator owns the state machine, stage publishing,
 * timeouts, and compensation (tasks 11.1/11.2). It depends only on the abstract
 * ports declared in `orchestrator.ts`. This module supplies the adapters that
 * map each concrete component onto its port, flattening every component's typed
 * error taxonomy into the uniform {@link PortError} (`{ message, detail }`).
 *
 * ## Adapter mapping (component -> port)
 *
 * | Stage      | Port                  | Backing component                         |
 * | ---------- | --------------------- | ----------------------------------------- |
 * | MODELING   | ModelingPort          | {@link ModelingEngine.inferFromPrompt}    |
 * | REFINING   | RefinementPort        | {@link RefinementEngine.applyAnswers}([]) |
 * | SCHEMA_GEN | SchemaGeneratorPort   | {@link generateSchema}(model,'POSTGRES')  |
 * | VERIFYING  | RoundTripVerifierPort | {@link DefaultRoundTripVerifier.verify}   |
 * | DEPLOYING  | ProvisionerPort       | {@link TransactionalProvisioner.apply}    |
 * | API_GEN    | ApiGeneratorPort      | {@link buildCrudSet} + {@link generateDescriptor} + {@link AuthService} |
 *
 * ## The deploy gate (Req 12.5)
 *
 * The Round-Trip Verifier adapter is the deploy gate: if `verify` reports a
 * round-trip diff, the adapter returns an `err(PortError)`, so the Orchestrator
 * fails the job at the VERIFYING stage and never advances to DEPLOYING. A lossy
 * schema can therefore never reach the live target.
 *
 * ## Compensation (Req 9.4)
 *
 * A {@link CompensationPort} is supplied so that, on a hard-timeout, any
 * partially produced backend artifacts for the job are discarded: the in-memory
 * record store is cleared and the captured backend reference is dropped, so no
 * Data_Model is left in `deployed` status.
 *
 * ## Local/demo wiring & dependency injection
 *
 * Everything is dependency-injectable so tests can drive the pipeline
 * deterministically:
 * - The default LLM client is a {@link StubLlmClient} — no live LLM dependency.
 *   Inject a real {@link LlmClient} to use a hosted model.
 * - The default Provisioner is backed by an {@link InMemoryDriver} (a
 *   transactional fake) targeting a local {@link DeploymentTarget}, so `run`
 *   works end to end without live AWS. Inject a real driver/target for a live
 *   deploy.
 * - The Orchestrator clock and id generator are injectable for deterministic
 *   timeout/identity tests.
 */
import type { DataModel, DeploymentTarget, GenerationJob, JobInput } from '../model/types.js';
import { type Clock as OrchestratorClock, type OrchestratorObserver } from '../orchestrator/orchestrator.js';
import { StubLlmClient, type LlmClient } from '../modeling/llmClient.js';
import { type Provisioner } from '../provisioner/provisioner.js';
import { type Clock as ProvisionerClock } from '../provisioner/driver.js';
import { type EntityCrudSet } from '../api/crudRuntime.js';
import type { SeedData } from '../modeling/records.js';
import { type ApiSurface } from '../api/apiGenerator.js';
import { type DashboardDescriptor } from '../dashboard/descriptor.js';
import { AuthService } from '../auth/authService.js';
/**
 * A placeholder Deployment_Target used for local/demo runs. The default
 * {@link InMemoryDriver} ignores the credentials (they only appear in
 * connectivity messages), so this lets `run` complete end to end without a live
 * AWS connection. Provide a real target (and a real driver) to deploy for real.
 */
export declare const LOCAL_DEPLOYMENT_TARGET: DeploymentTarget;
/**
 * The live backend the pipeline produces at the API_GEN stage of a successful
 * run: the CRUD runtime, the dashboard descriptor, the API surface, and the
 * Auth_Service that protects it. This is what makes the generated backend
 * actually usable (Req 5.1, 6.6, 7.1).
 */
export type Backend = {
    /** The accepted Data_Model this backend was generated from. */
    model: DataModel;
    /** The generated REST endpoint surface, one descriptor per entity (Req 5.1). */
    apiSurface: ApiSurface;
    /** The runtime serving CRUD against the shared store (Req 5.2–5.9). */
    crud: EntityCrudSet;
    /** The descriptor the Admin_Dashboard renders from (Req 7.1, 7.2). */
    dashboard: DashboardDescriptor;
    /** Role-based authentication for the live backend (Req 6.6). */
    auth: AuthService;
};
/**
 * The result of {@link GenerationPipeline.run}: the final {@link GenerationJob}
 * record (carrying status, current stage, model, migration, and any failure)
 * plus the live {@link Backend} when — and only when — the job reached the
 * `deployed` status. On any failure (including a deploy-gate rejection or a
 * timeout) `backend` is `undefined`.
 */
export type PipelineRunResult = {
    job: GenerationJob;
    backend?: Backend;
    /**
     * Set when the run deployed to a live target that persists seed data: the
     * schema deployed into, and either the persistence summary or an error
     * message if seeding the live database failed (the schema/deploy still
     * succeeded — only the data load is reported here).
     */
    dataPersistence?: {
        schema: string;
        ok: boolean;
        detail?: unknown;
        error?: string;
    };
    /**
     * The live schema this run deployed into, when it deployed to a per-run
     * isolated schema (live Postgres/Aurora). Present for every successful live
     * deploy regardless of whether seed rows existed — so callers can key the
     * generation by its schema and reconstruct it on any (serverless) instance.
     */
    deployedSchema?: string;
};
/**
 * Injectable dependencies for the pipeline. All optional; the defaults make a
 * fully working local pipeline (stub LLM + in-memory provisioner) so `run`
 * works without any external service.
 */
export type PipelineDependencies = {
    /** LLM client backing the Modeling_Engine. Defaults to {@link StubLlmClient}. */
    llmClient?: LlmClient;
    /**
     * The Provisioner used at the DEPLOYING stage. Defaults to a
     * {@link TransactionalProvisioner} over an {@link InMemoryDriver}. Inject a
     * real `pg`-backed provisioner for a live deploy.
     */
    provisioner?: Provisioner;
    /** The Deployment_Target the migration is applied to. Defaults to {@link LOCAL_DEPLOYMENT_TARGET}. */
    deploymentTarget?: DeploymentTarget;
    /** Clock for the default in-memory provisioner. Defaults to the system clock. */
    provisionerClock?: ProvisionerClock;
    /**
     * A pre-built Auth_Service to wire into produced backends. When omitted a
     * fresh {@link AuthService} (with default roles admin/viewer) is created per
     * run so the live backend has role-based auth (Req 6.6).
     */
    authService?: AuthService;
    /**
     * Per-run provisioner factory for live deploys that isolate each generation
     * into its own schema. When provided, the pipeline generates a unique schema
     * name per run and builds the provisioner bound to it (so the same schema can
     * be seeded afterward via {@link persistSeed}). Takes precedence over
     * {@link provisioner}.
     */
    makeProvisioner?: (schemaName: string) => Provisioner;
    /**
     * Persists the document-derived seed rows into the live deployment after a
     * successful deploy (e.g. INSERTing into the freshly created Postgres
     * schema), so the generated backend's database actually contains the
     * uploaded data — not just an empty schema. Receives the schema name the run
     * deployed into. Only invoked when seed rows exist and the run reached
     * `deployed`.
     */
    persistSeed?: (schemaName: string, model: DataModel, seed: SeedData) => Promise<unknown>;
    /**
     * Optional post-deploy optimization for live deploys (e.g. creating
     * search/filter indexes in the deployed schema). Best-effort: invoked after a
     * successful deploy and never fails the run. Receives the deployed schema.
     */
    optimize?: (schemaName: string, model: DataModel) => Promise<unknown>;
};
/**
 * Options forwarded to the underlying {@link Orchestrator} so tests can drive
 * timing and identity deterministically.
 */
export type PipelineOptions = {
    /** Monotonic clock (ms) for the orchestrator's timeout logic. */
    clock?: OrchestratorClock;
    /** Job-id generator. */
    generateId?: () => string;
    /** Observer for stage transitions / notices (Req 9.2, 9.5). */
    observer?: OrchestratorObserver;
};
/**
 * The single high-level entry point for the [MUST] vertical slice. Builds the
 * adapter graph, drives one input through the Orchestrator, and returns the
 * final job plus the live backend (when deployed).
 *
 * A fresh adapter graph, record store, and Orchestrator are constructed per
 * {@link run} call so concurrent runs never share mutable state and the
 * per-run backend/compensation references stay isolated.
 */
export declare class GenerationPipeline {
    private readonly deps;
    private readonly options;
    constructor(deps?: PipelineDependencies, options?: PipelineOptions);
    /**
     * Run a single Generation_Job end to end. Resolves with the final
     * {@link GenerationJob} and, on success, the live {@link Backend}. On any
     * failure (deploy-gate rejection, provisioning failure, or timeout) the job
     * carries the failing stage/reason and `backend` is `undefined`.
     */
    run(input: JobInput): Promise<PipelineRunResult>;
}
/**
 * Convenience: build a pipeline whose Modeling_Engine is driven by a stub LLM
 * returning the given raw candidate model (or a prompt-derived one). Useful for
 * demos and tests that want a deterministic model without constructing the LLM
 * client by hand.
 */
export declare function createStubPipeline(stub: ConstructorParameters<typeof StubLlmClient>[0], options?: PipelineOptions): GenerationPipeline;
