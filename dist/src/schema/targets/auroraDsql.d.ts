/**
 * Aurora DSQL target projection (Req 13.1).
 *
 * Aurora DSQL is a PostgreSQL-compatible relational engine, so for the scope of
 * this system the generated DDL is the same relational projection as the
 * primary Aurora PostgreSQL target: one `CREATE TABLE` per entity including the
 * entity's primary key, every column, and each column's mapped data type
 * (Req 13.1). The only difference is the `MigrationScript.target` tag, which is
 * `AURORA_DSQL`.
 *
 * Because it is the same relational projection, it inherits the same
 * fail-closed validations (undefined entity references → Req 3.7, unmappable
 * data types → Req 3.8, unorderable cyclic dependencies → Req 3.9), each
 * emitting no DDL (Req 3.10).
 */
import type { DataModel, MigrationScript } from '../../model/types.js';
import type { Result } from '../../model/result.js';
import { type SchemaGenError } from './relational.js';
import type { TargetProjection } from './targetProjection.js';
/**
 * Generate an Aurora DSQL migration script: one `CREATE TABLE` per entity with
 * its primary key, columns, and mapped column types (Req 13.1). Fails closed on
 * the same error conditions as the PostgreSQL projection.
 */
export declare function generateAuroraDsql(model: DataModel): Result<MigrationScript, SchemaGenError>;
/**
 * The Aurora DSQL {@link TargetProjection} plug-in.
 */
export declare const auroraDsqlProjection: TargetProjection;
