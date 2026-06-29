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
export {};
