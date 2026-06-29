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

import type { DbCredentials, DeploymentTarget } from '../model/types.js';

/** A readonly view of environment variables (e.g. `process.env`). */
export type EnvMap = Record<string, string | undefined>;

/** How the Modeling_Engine's LLM is provided. */
export type LlmConfig =
  | { provider: 'stub' }
  | {
      provider: 'http';
      endpoint: string;
      apiKey?: string;
      model: string;
    }
  | {
      provider: 'bedrock';
      modelId?: string;
      region?: string;
    };

/** Where generated schemas are deployed. */
export type DeploymentConfig =
  | { kind: 'memory' }
  | { kind: 'postgres'; target: DeploymentTarget };

/** The resolved application configuration. */
export type AppConfig = {
  llm: LlmConfig;
  deployment: DeploymentConfig;
  /** Non-fatal notes about defaults applied or fields missing. */
  warnings: string[];
};

/** A configuration error: a selected provider/target is missing required fields. */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

const DEFAULT_LLM_MODEL = 'gpt-4o-mini';

function trimmed(value: string | undefined): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const t = value.trim();
  return t.length > 0 ? t : undefined;
}

/**
 * Resolve the {@link AppConfig} from an environment map. Throws {@link ConfigError}
 * when a non-default provider/target is selected but its required fields are
 * missing, so misconfiguration fails fast rather than at first use.
 */
export function loadConfig(env: EnvMap): AppConfig {
  const warnings: string[] = [];
  return {
    llm: resolveLlm(env, warnings),
    deployment: resolveDeployment(env, warnings),
    warnings,
  };
}

function resolveLlm(env: EnvMap, warnings: string[]): LlmConfig {
  const provider = (trimmed(env.AIDA_LLM_PROVIDER) ?? 'stub').toLowerCase();

  if (provider === 'stub') {
    return { provider: 'stub' };
  }
  if (provider === 'http') {
    const endpoint = trimmed(env.AIDA_LLM_ENDPOINT);
    if (endpoint === undefined) {
      throw new ConfigError(
        'AIDA_LLM_PROVIDER=http requires AIDA_LLM_ENDPOINT to be set.',
      );
    }
    const model = trimmed(env.AIDA_LLM_MODEL);
    if (model === undefined) {
      warnings.push(
        `AIDA_LLM_MODEL not set; defaulting to "${DEFAULT_LLM_MODEL}".`,
      );
    }
    const apiKey = trimmed(env.AIDA_LLM_API_KEY);
    if (apiKey === undefined) {
      warnings.push('AIDA_LLM_API_KEY not set; sending unauthenticated requests.');
    }
    return {
      provider: 'http',
      endpoint,
      apiKey,
      model: model ?? DEFAULT_LLM_MODEL,
    };
  }

  if (provider === 'bedrock') {
    const modelId = trimmed(env.AIDA_BEDROCK_MODEL_ID);
    const region =
      trimmed(env.AIDA_BEDROCK_REGION) ??
      trimmed(env.AWS_REGION) ??
      trimmed(env.AWS_DEFAULT_REGION);
    if (region === undefined) {
      warnings.push(
        'No AWS region configured (AIDA_BEDROCK_REGION/AWS_REGION); defaulting to us-east-1.',
      );
    }
    if (modelId === undefined) {
      warnings.push(
        'AIDA_BEDROCK_MODEL_ID not set; using the default model (Amazon Nova Pro).',
      );
    }
    return { provider: 'bedrock', modelId, region };
  }

  throw new ConfigError(
    `Unknown AIDA_LLM_PROVIDER "${provider}". Supported: stub, http, bedrock.`,
  );
}

function resolveDeployment(env: EnvMap, warnings: string[]): DeploymentConfig {
  const kind = (trimmed(env.AIDA_DEPLOY_TARGET) ?? 'memory').toLowerCase();

  if (kind === 'memory') {
    return { kind: 'memory' };
  }
  if (kind === 'postgres') {
    return { kind: 'postgres', target: resolvePostgresTarget(env, warnings) };
  }

  throw new ConfigError(
    `Unknown AIDA_DEPLOY_TARGET "${kind}". Supported: memory, postgres.`,
  );
}

function resolvePostgresTarget(
  env: EnvMap,
  warnings: string[],
): DeploymentTarget {
  const host = trimmed(env.AIDA_DB_HOST);
  const database = trimmed(env.AIDA_DB_NAME);
  const user = trimmed(env.AIDA_DB_USER);
  const password = trimmed(env.AIDA_DB_PASSWORD);

  const missing: string[] = [];
  if (host === undefined) missing.push('AIDA_DB_HOST');
  if (database === undefined) missing.push('AIDA_DB_NAME');
  if (user === undefined) missing.push('AIDA_DB_USER');
  if (password === undefined) missing.push('AIDA_DB_PASSWORD');
  if (missing.length > 0) {
    throw new ConfigError(
      `AIDA_DEPLOY_TARGET=postgres requires: ${missing.join(', ')}.`,
    );
  }

  const portRaw = trimmed(env.AIDA_DB_PORT);
  let port = 5432;
  if (portRaw !== undefined) {
    const parsed = Number(portRaw);
    if (!Number.isInteger(parsed) || parsed <= 0) {
      throw new ConfigError(`AIDA_DB_PORT must be a positive integer, got "${portRaw}".`);
    }
    port = parsed;
  } else {
    warnings.push('AIDA_DB_PORT not set; defaulting to 5432.');
  }

  const connection: DbCredentials = {
    host: host as string,
    port,
    database: database as string,
    user: user as string,
    password: password as string,
  };
  return { kind: 'POSTGRES', connection };
}
