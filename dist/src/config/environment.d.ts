/**
 * Environment-driven configuration for the AI Database Architect.
 *
 * Resolves which concrete adapters the pipeline should use — a real LLM vs. the
 * deterministic stub, and a live Aurora PostgreSQL Deployment_Target vs. the
 * in-memory transactional provisioner — from process environment variables.
 *
 * `loadConfig` is a pure function of an environment map so it is fully
 * unit-testable without touching `process.env`.
 *
 * Recognized variables:
 *   LLM
 *     AIDA_LLM_PROVIDER   'stub' | 'http'         (default: 'stub')
 *     AIDA_LLM_ENDPOINT   chat-completions URL    (required when provider=http)
 *     AIDA_LLM_API_KEY    bearer key              (optional)
 *     AIDA_LLM_MODEL      model id                (default: 'gpt-4o-mini')
 *   Deployment target
 *     AIDA_DEPLOY_TARGET  'memory' | 'postgres'   (default: 'memory')
 *     AIDA_DB_HOST, AIDA_DB_PORT, AIDA_DB_NAME, AIDA_DB_USER, AIDA_DB_PASSWORD
 *                         Aurora PostgreSQL connection (required when target=postgres)
 */
import type { DeploymentTarget } from '../model/types.js';
/** A readonly view of environment variables (e.g. `process.env`). */
export type EnvMap = Record<string, string | undefined>;
/** How the Modeling_Engine's LLM is provided. */
export type LlmConfig = {
    provider: 'stub';
} | {
    provider: 'http';
    endpoint: string;
    apiKey?: string;
    model: string;
} | {
    provider: 'bedrock';
    modelId?: string;
    region?: string;
};
/** Where generated schemas are deployed. */
export type DeploymentConfig = {
    kind: 'memory';
} | {
    kind: 'postgres';
    target: DeploymentTarget;
};
/** The resolved application configuration. */
export type AppConfig = {
    llm: LlmConfig;
    deployment: DeploymentConfig;
    /** Non-fatal notes about defaults applied or fields missing. */
    warnings: string[];
};
/** A configuration error: a selected provider/target is missing required fields. */
export declare class ConfigError extends Error {
    constructor(message: string);
}
/**
 * Resolve the {@link AppConfig} from an environment map. Throws {@link ConfigError}
 * when a non-default provider/target is selected but its required fields are
 * missing, so misconfiguration fails fast rather than at first use.
 */
export declare function loadConfig(env: EnvMap): AppConfig;
