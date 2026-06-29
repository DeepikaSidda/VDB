/**
 * The Data_Model Intermediate Representation (IR) and the Generation_Job /
 * deployment types that surround it.
 *
 * The Data_Model is the dialect-independent contract between the intelligence
 * layer (Modeling_Engine, Refinement_Engine) and the deterministic
 * transformation layer (Schema_Generator, Round-Trip Verifier, API_Generator,
 * Auth_Service, Admin_Dashboard). Every generator consumes it and the
 * round-trip verifier reconstructs it, so the field names and union member
 * shapes here are a stable, shared contract — they must not drift.
 *
 * Defined exactly as specified in the design's "Data Models" section.
 */

// ---------------------------------------------------------------------------
// The Data_Model Intermediate Representation
// ---------------------------------------------------------------------------

/**
 * The root IR: the set of entities and the relationships between them.
 */
export type DataModel = {
  entities: Entity[];
  relationships: Relationship[];
};

/**
 * A single entity (table) in the Data_Model.
 */
export type Entity = {
  /** Unique within the model. */
  name: string;
  attributes: Attribute[];
  /** Exactly one PK; >1 element = composite (Req 1.2, 3.2). */
  primaryKey: string[];
  /** True for synthesized many-to-many join tables (Req 1.5). */
  isJoinEntity: boolean;
  /** Low-confidence flag for builder review (Req 2.7). */
  needsReview?: boolean;
};

/**
 * A single attribute (column) of an entity.
 */
export type Attribute = {
  /** Unique within its entity. */
  name: string;
  /** Exactly one supported type (Req 1.4). */
  dataType: DataType;
  constraints: AttributeConstraint[];
  /** Low-confidence flag for builder review (Req 2.7). */
  needsReview?: boolean;
};

/**
 * The closed set of supported attribute data types. The Schema_Generator maps
 * each of these to an Aurora PostgreSQL type; anything outside this set is an
 * unmappable-type error (Req 3.8).
 */
export type DataType =
  | 'UUID' | 'TEXT' | 'VARCHAR' | 'INTEGER' | 'BIGINT'
  | 'NUMERIC' | 'BOOLEAN' | 'DATE' | 'TIMESTAMP' | 'JSON';

/**
 * A constraint attached to an attribute. Discriminated on `kind`.
 */
export type AttributeConstraint =
  | { kind: 'PRIMARY_KEY' }
  | { kind: 'UNIQUE' }                                   // Req 2.1
  | { kind: 'NOT_NULL' }                                 // Req 2.2
  | { kind: 'FORMAT'; format: 'EMAIL' }                  // Req 2.3
  | { kind: 'RANGE'; min?: number; max?: number }        // Req 2.4
  | { kind: 'FOREIGN_KEY'; references: { entity: string; attribute: string } }; // Req 2.5

/**
 * A directed relationship between two entities. For MANY_TO_MANY, the
 * Modeling_Engine also emits a join Entity (Req 1.5).
 */
export type Relationship = {
  /** Entity name. */
  source: string;
  /** Entity name. */
  target: string;
  /** Req 1.3. */
  cardinality: 'ONE_TO_ONE' | 'ONE_TO_MANY' | 'MANY_TO_MANY';
};

// ---------------------------------------------------------------------------
// Generation_Job
// ---------------------------------------------------------------------------

/**
 * The orchestration stages of a Generation_Job. The active stage is the unit
 * of progress reporting (Req 9.2) and timeout reporting (Req 9.3).
 */
export type GenerationStage =
  | 'SUBMITTED' | 'MODELING' | 'REFINING' | 'SCHEMA_GEN'
  | 'VERIFYING' | 'DEPLOYING' | 'API_GEN' | 'DEPLOYED' | 'FAILED';

/**
 * An uploaded document carried in a {@link JobInput}. `content` is text (CSV)
 * or base64-encoded bytes (Excel/PDF) per `encoding`.
 */
export type UploadedDocument = {
  name: string;
  format?: string;
  contentType?: string;
  content: string;
  encoding?: 'utf8' | 'base64';
};

/** The source database engine for an existing-database import (Req 11). */
export type ImportEngine = 'postgres' | 'mysql';

/**
 * The input that initiates a Generation_Job. The three ways to create a
 * backend: a natural-language prompt (Req 1), an uploaded document (Req 10), or
 * an existing database to import and migrate (Req 11).
 */
export type JobInput =
  | { kind: 'PROMPT'; prompt: string }
  | { kind: 'DOCUMENT'; document: UploadedDocument }
  | { kind: 'IMPORT'; engine: ImportEngine; connection: DbCredentials };

/**
 * A single end-to-end run transforming one input into a deployed backend.
 */
export type GenerationJob = {
  id: string;
  input: JobInput;
  model?: DataModel;
  migration?: MigrationScript;
  currentStage: GenerationStage;
  status: 'submitted' | 'running' | 'deployed' | 'failed';
  startedAt: number;
  failure?: { stage: GenerationStage; reason: string };
};

// ---------------------------------------------------------------------------
// MigrationScript and Deployment
// ---------------------------------------------------------------------------

/**
 * The supported deployment targets. POSTGRES is the primary demo target;
 * AURORA_DSQL and DYNAMODB are stretch targets (Req 13).
 */
export type DeploymentTargetKind = 'POSTGRES' | 'AURORA_DSQL' | 'DYNAMODB';

/**
 * An ordered migration script: a topologically ordered list of DDL statements
 * for a given target (Req 3.6).
 */
export type MigrationScript = {
  target: DeploymentTargetKind;
  /** Ordered (Req 3.6). */
  statements: DdlStatement[];
};

/**
 * A single DDL statement, tagged with the structural kind it produces.
 */
export type DdlStatement = {
  sql: string;
  kind: 'CREATE_TABLE' | 'ADD_FK' | 'CREATE_INDEX';
};

/**
 * Connection credentials for a Deployment_Target.
 */
export type DbCredentials = {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
};

/**
 * A concrete deployment target: a target kind plus the connection used to
 * apply a migration to it.
 */
export type DeploymentTarget = {
  kind: DeploymentTargetKind;
  connection: DbCredentials;
};

/**
 * The outcome of applying a migration to a Deployment_Target (Req 4).
 */
export type DeployResult =
  | { status: 'deployed' }
  | { status: 'failed'; reason: string; cause: 'CONNECTIVITY' | 'MIGRATION' };
