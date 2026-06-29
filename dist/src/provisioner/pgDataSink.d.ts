/**
 * Postgres data sink — loads the document-derived seed rows into the live
 * Aurora/RDS PostgreSQL schema that the migration just created.
 *
 * The Provisioner deploys the *schema* (CREATE TABLE / foreign keys / indexes)
 * into a per-generation schema `gen_<id>`. This module is the missing half that
 * makes the generated backend a genuinely database-backed one: after that
 * schema is committed, it opens a connection, sets `search_path` to the same
 * schema, and INSERTs the seeded rows with parameterized statements.
 *
 * Rows are inserted in the seed map's order (referenced/group entities first,
 * the main entity last) so foreign-key constraints are satisfied. Each row's
 * present columns are inserted by name; absent columns fall back to their
 * column default / NULL. Inserts are parameterized (never string-interpolated)
 * so values cannot break out of their placeholders.
 *
 * The `pg` module is imported lazily so loading this file never fails when the
 * optional dependency is absent (e.g. a pure in-memory run).
 */
import type { DataModel, DeploymentTarget } from '../model/types.js';
import type { SeedData } from '../modeling/records.js';
/** Outcome of a seeding pass: how many rows were inserted per entity. */
export type SeedPersistResult = {
    schema: string;
    inserted: Record<string, number>;
    total: number;
};
/**
 * Insert the seeded rows into the deployed schema on the live target.
 *
 * Connects to `target`, sets `search_path` to `schema`, and inserts every seed
 * row for each entity (in seed order). Only columns declared on the entity in
 * `model` are written, so unknown keys never reach the database. Returns the
 * per-entity inserted counts.
 *
 * Throws on a connection failure; individual row failures are collected and
 * re-thrown as a single aggregate error after attempting the rest, so one bad
 * row does not silently drop the remainder.
 */
export declare function persistSeedToPostgres(target: DeploymentTarget, schema: string, model: DataModel, seed: SeedData): Promise<SeedPersistResult>;
