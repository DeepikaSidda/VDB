/**
 * Public API surface for the AI Database Architect backend engine.
 *
 * Consumers (the Next.js web app, the CLI, tests, or downstream services)
 * import from here rather than reaching into individual modules.
 */
export { ok, err, isOk, isErr, } from './model/result.js';
// The end-to-end pipeline + composition roots
export { GenerationPipeline, createStubPipeline, LOCAL_DEPLOYMENT_TARGET, } from './pipeline/pipeline.js';
export { createPipeline, createPipelineFromEnv, createDependencies, createLlmClient, } from './pipeline/factory.js';
// Configuration
export { loadConfig, ConfigError, } from './config/environment.js';
// LLM clients
export { StubLlmClient } from './modeling/llmClient.js';
export { HttpLlmClient, LlmRequestError } from './modeling/httpLlmClient.js';
export { BedrockLlmClient, BedrockRequestError, DEFAULT_BEDROCK_MODEL_ID, } from './modeling/bedrockLlmClient.js';
// Adapters (real, live-infrastructure backed)
export { PgDriver } from './provisioner/pgDriver.js';
export { PgSource } from './import/pgSource.js';
// Generators reused by the web layer
export { generateDescriptor } from './dashboard/descriptor.js';
export { searchRecords, filterRecords } from './dashboard/query.js';
//# sourceMappingURL=index.js.map