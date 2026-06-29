/**
 * Unit tests for environment-driven configuration (src/config/environment.ts).
 *
 * `loadConfig` is a pure function of an env map, so these cover the default
 * (local) configuration, the real HTTP-LLM + Aurora PostgreSQL selection, and
 * the fail-fast errors for misconfiguration.
 */

import { describe, it, expect } from 'vitest';
import { loadConfig, ConfigError } from '../../src/config/environment.js';

describe('loadConfig — defaults', () => {
  it('defaults to the stub LLM and in-memory deployment with no env', () => {
    const config = loadConfig({});
    expect(config.llm).toEqual({ provider: 'stub' });
    expect(config.deployment).toEqual({ kind: 'memory' });
  });
});

describe('loadConfig — HTTP LLM', () => {
  it('resolves an http LLM with endpoint, key, and model', () => {
    const config = loadConfig({
      AIDA_LLM_PROVIDER: 'http',
      AIDA_LLM_ENDPOINT: 'https://api.example.com/v1/chat/completions',
      AIDA_LLM_API_KEY: 'sk-test',
      AIDA_LLM_MODEL: 'gpt-4o-mini',
    });
    expect(config.llm).toEqual({
      provider: 'http',
      endpoint: 'https://api.example.com/v1/chat/completions',
      apiKey: 'sk-test',
      model: 'gpt-4o-mini',
    });
  });

  it('defaults the model and warns when AIDA_LLM_MODEL/API_KEY are absent', () => {
    const config = loadConfig({
      AIDA_LLM_PROVIDER: 'http',
      AIDA_LLM_ENDPOINT: 'https://api.example.com/v1/chat/completions',
    });
    expect(config.llm.provider).toBe('http');
    if (config.llm.provider === 'http') {
      expect(config.llm.model).toBe('gpt-4o-mini');
      expect(config.llm.apiKey).toBeUndefined();
    }
    expect(config.warnings.some((w) => w.includes('AIDA_LLM_MODEL'))).toBe(true);
    expect(config.warnings.some((w) => w.includes('AIDA_LLM_API_KEY'))).toBe(true);
  });

  it('throws when http is selected without an endpoint', () => {
    expect(() => loadConfig({ AIDA_LLM_PROVIDER: 'http' })).toThrow(ConfigError);
  });

  it('throws for an unknown provider', () => {
    expect(() => loadConfig({ AIDA_LLM_PROVIDER: 'magic' })).toThrow(ConfigError);
  });
});

describe('loadConfig — Aurora PostgreSQL deployment', () => {
  const base = {
    AIDA_DEPLOY_TARGET: 'postgres',
    AIDA_DB_HOST: 'cluster.aws',
    AIDA_DB_NAME: 'app',
    AIDA_DB_USER: 'admin',
    AIDA_DB_PASSWORD: 'secret',
  };

  it('resolves a postgres target with the connection and default port', () => {
    const config = loadConfig(base);
    expect(config.deployment.kind).toBe('postgres');
    if (config.deployment.kind === 'postgres') {
      expect(config.deployment.target.kind).toBe('POSTGRES');
      expect(config.deployment.target.connection).toEqual({
        host: 'cluster.aws',
        port: 5432,
        database: 'app',
        user: 'admin',
        password: 'secret',
      });
    }
    expect(config.warnings.some((w) => w.includes('AIDA_DB_PORT'))).toBe(true);
  });

  it('honors an explicit port', () => {
    const config = loadConfig({ ...base, AIDA_DB_PORT: '6543' });
    if (config.deployment.kind === 'postgres') {
      expect(config.deployment.target.connection.port).toBe(6543);
    }
  });

  it('throws when required connection fields are missing', () => {
    expect(() =>
      loadConfig({ AIDA_DEPLOY_TARGET: 'postgres', AIDA_DB_HOST: 'h' }),
    ).toThrow(ConfigError);
  });

  it('throws for a non-numeric port', () => {
    expect(() => loadConfig({ ...base, AIDA_DB_PORT: 'abc' })).toThrow(ConfigError);
  });

  it('throws for an unknown deploy target', () => {
    expect(() => loadConfig({ AIDA_DEPLOY_TARGET: 'mysql' })).toThrow(ConfigError);
  });
});
