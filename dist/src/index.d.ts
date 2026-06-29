/**
 * Public API surface for the AI Database Architect backend engine.
 *
 * Consumers (the Next.js web app, the CLI, tests, or downstream services)
 * import from here rather than reaching into individual modules.
 */
export type { DataModel, Entity, Attribute, DataType, AttributeConstraint, Relationship, GenerationStage, GenerationJob, JobInput, MigrationScript, DdlStatement, DeploymentTarget, DeploymentTargetKind, DeployResult, DbCredentials, } from './model/types.js';
export { type Result, ok, err, isOk, isErr, } from './model/result.js';
export { GenerationPipeline, createStubPipeline, type Backend, type PipelineRunResult, type PipelineDependencies, type PipelineOptions, LOCAL_DEPLOYMENT_TARGET, } from './pipeline/pipeline.js';
export { createPipeline, createPipelineFromEnv, createDependencies, createLlmClient, } from './pipeline/factory.js';
export { loadConfig, ConfigError, type AppConfig, type LlmConfig, type DeploymentConfig, type EnvMap, } from './config/environment.js';
export { StubLlmClient, type LlmClient, type RawCandidateModel } from './modeling/llmClient.js';
export { HttpLlmClient, LlmRequestError } from './modeling/httpLlmClient.js';
export { BedrockLlmClient, BedrockRequestError, DEFAULT_BEDROCK_MODEL_ID, type BedrockLlmClientConfig, } from './modeling/bedrockLlmClient.js';
export { PgDriver } from './provisioner/pgDriver.js';
export { PgSource } from './import/pgSource.js';
export { generateDescriptor } from './dashboard/descriptor.js';
export { searchRecords, filterRecords } from './dashboard/query.js';
