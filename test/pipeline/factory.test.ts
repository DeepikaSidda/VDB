/**
 * Tests for the pipeline factory (src/pipeline/factory.ts).
 *
 * Verify the composition root selects the correct adapters from an AppConfig:
 * the stub vs. real HTTP LLM client, and the in-memory vs. live Aurora
 * PostgreSQL provisioner. The default (stub + memory) pipeline is exercised end
 * to end to confirm the factory produces a working pipeline.
 */

import { describe, it, expect } from 'vitest';
import {
  createLlmClient,
  createDependencies,
  createPipeline,
  createPipelineFromEnv,
} from '../../src/pipeline/factory.js';
import { StubLlmClient } from '../../src/modeling/llmClient.js';
import { HttpLlmClient } from '../../src/modeling/httpLlmClient.js';
import { TransactionalProvisioner } from '../../src/provisioner/provisioner.js';
import type { AppConfig } from '../../src/config/environment.js';

const STUB_CONFIG: AppConfig = {
  llm: { provider: 'stub' },
  deployment: { kind: 'memory' },
  warnings: [],
};

const REAL_CONFIG: AppConfig = {
  llm: {
    provider: 'http',
    endpoint: 'https://api.example.com/v1/chat/completions',
    apiKey: 'sk-test',
    model: 'gpt-4o-mini',
  },
  deployment: {
    kind: 'postgres',
    target: {
      kind: 'POSTGRES',
      connection: { host: 'h', port: 5432, database: 'd', user: 'u', password: 'p' },
    },
  },
  warnings: [],
};

describe('createLlmClient', () => {
  it('returns a StubLlmClient for the stub provider', () => {
    expect(createLlmClient(STUB_CONFIG)).toBeInstanceOf(StubLlmClient);
  });

  it('returns an HttpLlmClient for the http provider', () => {
    expect(createLlmClient(REAL_CONFIG)).toBeInstanceOf(HttpLlmClient);
  });
});

describe('createDependencies', () => {
  it('omits provisioner/target for the in-memory deployment (pipeline default used)', () => {
    const deps = createDependencies(STUB_CONFIG);
    expect(deps.llmClient).toBeInstanceOf(StubLlmClient);
    expect(deps.provisioner).toBeUndefined();
    expect(deps.deploymentTarget).toBeUndefined();
  });

  it('wires a per-run provisioner factory, seeder, and target for the postgres deployment', () => {
    const deps = createDependencies(REAL_CONFIG);
    expect(deps.llmClient).toBeInstanceOf(HttpLlmClient);
    expect(deps.deploymentTarget?.kind).toBe('POSTGRES');
    // Live Postgres deploys build the provisioner per run (bound to a unique
    // schema) and supply a seeder that loads the data into that schema.
    expect(typeof deps.makeProvisioner).toBe('function');
    expect(deps.makeProvisioner?.('gen_test')).toBeInstanceOf(TransactionalProvisioner);
    expect(typeof deps.persistSeed).toBe('function');
  });
});

describe('createPipeline / createPipelineFromEnv', () => {
  it('builds a working local pipeline that deploys from the stub config', async () => {
    const pipeline = createPipeline(STUB_CONFIG);
    const { job, backend } = await pipeline.run({
      kind: 'PROMPT',
      prompt: 'Build a hotel booking system',
    });
    // The heuristic stub yields a hotel-domain model, so the local pipeline
    // runs end to end to a deployed backend with no LLM key.
    expect(job.status).toBe('deployed');
    expect(backend?.crud.entityNames()).toContain('Hotel');
  });

  it('resolves a pipeline + config from an environment map', () => {
    const { pipeline, config } = createPipelineFromEnv({});
    expect(pipeline).toBeDefined();
    expect(config.llm.provider).toBe('stub');
    expect(config.deployment.kind).toBe('memory');
  });
});
