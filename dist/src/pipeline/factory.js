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
import { GenerationPipeline, } from './pipeline.js';
import { StubLlmClient } from '../modeling/llmClient.js';
import { HttpLlmClient } from '../modeling/httpLlmClient.js';
import { BedrockLlmClient } from '../modeling/bedrockLlmClient.js';
import { heuristicCandidate } from '../modeling/heuristicStub.js';
import { TransactionalProvisioner } from '../provisioner/provisioner.js';
import { PgDriver } from '../provisioner/pgDriver.js';
import { persistSeedToPostgres } from '../provisioner/pgDataSink.js';
import { createSearchIndexes } from '../provisioner/pgIndexer.js';
import { loadConfig, } from '../config/environment.js';
/** Build the LLM client an {@link AppConfig} selects. */
export function createLlmClient(config) {
    if (config.llm.provider === 'http') {
        return new HttpLlmClient({
            endpoint: config.llm.endpoint,
            apiKey: config.llm.apiKey,
            model: config.llm.model,
        });
    }
    if (config.llm.provider === 'bedrock') {
        return new BedrockLlmClient({
            modelId: config.llm.modelId,
            region: config.llm.region,
        });
    }
    // The 'stub' provider uses a deterministic offline heuristic so the system
    // runs end to end without an LLM key (real inference is HttpLlmClient).
    return new StubLlmClient(heuristicCandidate);
}
/**
 * Build the {@link PipelineDependencies} an {@link AppConfig} selects. A
 * `postgres` deployment target uses a real {@link PgDriver}-backed provisioner
 * and the configured Aurora connection; a `memory` target lets the pipeline use
 * its default in-memory transactional provisioner.
 */
export function createDependencies(config) {
    const deps = {
        llmClient: createLlmClient(config),
    };
    if (config.deployment.kind === 'postgres') {
        const target = config.deployment.target;
        deps.deploymentTarget = target;
        // Per-run provisioner: each generation deploys into its own unique schema
        // (gen_<id>) so repeated runs never collide.
        deps.makeProvisioner = (schemaName) => new TransactionalProvisioner(new PgDriver({ schemaName }));
        // After the schema deploys, load the document's rows into that same schema
        // so the live database actually contains the data (not just empty tables).
        deps.persistSeed = (schemaName, model, seed) => persistSeedToPostgres(target, schemaName, model, seed);
        // After deploy + seeding, add trigram (search) and btree (filter) indexes
        // so the dashboard stays fast on large tables. Best-effort.
        deps.optimize = (schemaName, model) => createSearchIndexes(target, schemaName, model);
    }
    return deps;
}
/**
 * Build a {@link GenerationPipeline} from a resolved {@link AppConfig}.
 */
export function createPipeline(config, options = {}) {
    return new GenerationPipeline(createDependencies(config), options);
}
/**
 * Build a {@link GenerationPipeline} directly from an environment map
 * (defaults to `process.env`). Convenience composition root for servers/CLIs.
 */
export function createPipelineFromEnv(env = process.env, options = {}) {
    const config = loadConfig(env);
    return { pipeline: createPipeline(config, options), config };
}
//# sourceMappingURL=factory.js.map