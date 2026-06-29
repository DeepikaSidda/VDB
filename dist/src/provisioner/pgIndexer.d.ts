/**
 * Post-deploy index optimizer for live Aurora/RDS PostgreSQL deploys.
 *
 * The migration itself already creates a btree index per foreign-key column
 * (Req 3.5). This adds, AFTER a successful deploy, two more classes of index so
 * the generated dashboard stays fast on large tables:
 *
 *  - **Trigram GIN indexes** on TEXT/VARCHAR columns — these accelerate the
 *    dashboard's case-insensitive substring search (`col ILIKE '%term%'`),
 *    which a plain btree index cannot help. Requires the `pg_trgm` extension
 *    (a trusted, user-creatable contrib extension on RDS PostgreSQL 13+).
 *  - **Btree indexes** on the remaining scalar columns (numbers, dates,
 *    booleans) — these accelerate equality / range filters and sorting.
 *
 * It runs as a separate best-effort pass (NOT part of the verified migration),
 * so it can never break the round-trip deploy gate, and any individual failure
 * (e.g. the extension being unavailable) is swallowed — the deployed backend
 * still works, just without that particular index. Every statement uses
 * `IF NOT EXISTS` so re-running is safe.
 */
import type { DataModel, DeploymentTarget } from '../model/types.js';
/** The summary of an index-optimization pass. */
export type IndexResult = {
    schema: string;
    created: number;
    skipped: number;
};
/**
 * Create search/filter indexes for every entity in `model` within the deployed
 * `schema` on the live `target`. Best-effort throughout; returns how many
 * indexes were created vs skipped (already-present or failed).
 */
export declare function createSearchIndexes(target: DeploymentTarget, schema: string, model: DataModel): Promise<IndexResult>;
