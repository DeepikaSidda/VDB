/**
 * Command-line entry point for the AI Database Architect.
 *
 * Usage:
 *   node dist/src/cli.js "Build a hotel booking system"
 *
 * Resolves the pipeline from the environment (see src/config/environment.ts):
 * with no env it runs fully locally (stub LLM + in-memory transactional
 * provisioner); set AIDA_LLM_PROVIDER=http and AIDA_DEPLOY_TARGET=postgres
 * (plus the AIDA_LLM_* / AIDA_DB_* variables) to drive a real LLM and deploy to
 * a live Amazon Aurora PostgreSQL database.
 *
 * Prints the generation job's progress (stage transitions), then the resulting
 * entities, generated REST endpoints, and dashboard entity list.
 */

import { createPipelineFromEnv } from './pipeline/factory.js';
import type { GenerationStage } from './model/types.js';

async function main(): Promise<void> {
  const prompt = process.argv.slice(2).join(' ').trim();
  if (prompt.length === 0) {
    process.stderr.write(
      'Usage: node dist/src/cli.js "<domain description>"\n',
    );
    process.exitCode = 2;
    return;
  }

  const { pipeline, config } = createPipelineFromEnv(process.env, {
    observer: {
      onStageTransition: (e: { stage: GenerationStage }) =>
        process.stdout.write(`  → ${e.stage}\n`),
      onNotice: (e: { message: string }) =>
        process.stdout.write(`  ! ${e.message}\n`),
    },
  });

  process.stdout.write(
    `LLM: ${config.llm.provider} | deploy target: ${config.deployment.kind}\n`,
  );
  for (const warning of config.warnings) {
    process.stdout.write(`  (config) ${warning}\n`);
  }
  process.stdout.write(`Generating backend for: "${prompt}"\n`);

  const { job, backend } = await pipeline.run({ kind: 'PROMPT', prompt });

  if (job.status !== 'deployed' || backend === undefined) {
    process.stderr.write(
      `\nGeneration failed at stage ${job.failure?.stage ?? job.currentStage}: ${
        job.failure?.reason ?? 'unknown error'
      }\n`,
    );
    process.exitCode = 1;
    return;
  }

  process.stdout.write('\nDeployed backend:\n');
  process.stdout.write(`  Entities: ${backend.crud.entityNames().join(', ')}\n`);

  process.stdout.write('  REST endpoints:\n');
  for (const entity of backend.apiSurface.entities) {
    for (const endpoint of entity.endpoints) {
      process.stdout.write(`    ${endpoint.method.padEnd(6)} ${endpoint.path}\n`);
    }
  }

  process.stdout.write(
    `  Dashboard views: ${backend.dashboard.entities
      .map((e) => e.entityName)
      .join(', ')}\n`,
  );
}

main().catch((error: unknown) => {
  process.stderr.write(
    `Fatal: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
