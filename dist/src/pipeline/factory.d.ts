/**
 * Pipeline factory — wires the {@link GenerationPipeline} with the concrete
 * adapters selected by {@link AppConfig} (or the process environment).
 *
 * This is the single composition root that turns configuration into a runnable
 * pipeline: it chooses a real {@link HttpLlmClient} or the deterministic
 * {@link StubLlmClient}, and a live Aurora PostgreSQL provisioner
 * ({@link TransactionalProvisioner} over {@link PgDriver}) or the in-memory
 * transactional provisioner — without the pipeline or orchestrator knowing
 * which. Keeping the selection here means the rest of the system depends only
 * on the injectable ports.
 */
import { GenerationPipeline, type PipelineDependencies, type PipelineOptions } from './pipeline.js';
import { type LlmClient } from '../modeling/llmClient.js';
import { type AppConfig, type EnvMap } from '../config/environment.js';
/** Build the LLM client an {@link AppConfig} selects. */
export declare function createLlmClient(config: AppConfig): LlmClient;
/**
 * Build the {@link PipelineDependencies} an {@link AppConfig} selects. A
 * `postgres` deployment target uses a real {@link PgDriver}-backed provisioner
 * and the configured Aurora connection; a `memory` target lets the pipeline use
 * its default in-memory transactional provisioner.
 */
export declare function createDependencies(config: AppConfig): PipelineDependencies;
/**
 * Build a {@link GenerationPipeline} from a resolved {@link AppConfig}.
 */
export declare function createPipeline(config: AppConfig, options?: PipelineOptions): GenerationPipeline;
/**
 * Build a {@link GenerationPipeline} directly from an environment map
 * (defaults to `process.env`). Convenience composition root for servers/CLIs.
 */
export declare function createPipelineFromEnv(env?: EnvMap, options?: PipelineOptions): {
    pipeline: GenerationPipeline;
    config: AppConfig;
};
