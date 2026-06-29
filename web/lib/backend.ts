/**
 * Server-side adapter between the Next.js route handlers and the AI Database
 * Architect backend engine.
 *
 * ## How the frontend reaches the backend pipeline
 *
 * The backend engine is the in-process TypeScript pipeline that lives at the
 * repository root under `src/`. It is compiled to `dist/src/**` (with `.d.ts`
 * declarations), so this module imports it **as a built library** from the
 * compiled output:
 *
 *   import { GenerationPipeline } from '../../dist/src/pipeline/pipeline.js';
 *
 * This is the production-accurate shape of the dependency (the web app consumes
 * the backend as a library/build, not by reaching into its raw `.ts` sources),
 * and it keeps the web app a separate package that never destabilizes the root
 * project's tsconfig/build/test. `next.config.mjs` sets
 * `experimental.externalDir: true` so Next can bundle these out-of-app modules.
 *
 * To run:  cd web; npm install; npm run dev   (after `npm run build` at the
 * repo root so `dist/` exists).
 *
 * ## Server-side session store
 *
 * Generation is started asynchronously and tracked in a process-local
 * `Map<generationId, GenerationSession>`. Each session captures the live stage
 * progression (published by the orchestrator via the observer hooks — Req 9.2),
 * any pre-start notice (Req 9.5), the terminal status/failure, and, on success,
 * the live {@link Backend} (CRUD runtime + dashboard descriptor + auth). The
 * dashboard route handlers act on `session.backend.crud` so create/edit/delete
 * operate on the actually-deployed backend.
 *
 * This in-memory store is per server process — fine for a hackathon/demo. A
 * production deployment would persist sessions in a shared store keyed by job.
 */

import type { Backend } from '../../dist/src/pipeline/pipeline.js';
import { createPipelineFromEnv } from '../../dist/src/pipeline/factory.js';
import { deriveQuestions } from '../../dist/src/refinement/refinementEngine.js';
import type {
  DataModel,
  DbCredentials,
  GenerationStage,
  JobInput,
} from '../../dist/src/model/types.js';
import type { DashboardDescriptor } from '../../dist/src/dashboard/descriptor.js';
import type { ClarifyingQuestion } from '../../dist/src/refinement/refinementEngine.js';
import { buildCrudSet } from '../../dist/src/api/crudRuntime.js';
import { generate as generateApiSurface } from '../../dist/src/api/apiGenerator.js';
import { generateDescriptor } from '../../dist/src/dashboard/descriptor.js';
import { AuthService } from '../../dist/src/auth/authService.js';
import { SourceImportAnalyzer } from '../../dist/src/import/importAnalyzer.js';
import { PgSource } from '../../dist/src/import/pgSource.js';

/** The lifecycle status of a generation session, as surfaced to the UI. */
export type SessionStatus = 'running' | 'deployed' | 'failed';

/** A single stage transition captured for the job-status timeline (Req 9.2). */
export type StageEvent = {
  stage: GenerationStage;
  at: number;
};

/**
 * A tracked generation run. `backend` is only present once the run reaches the
 * `deployed` status; it is intentionally **not** serialized to the client
 * (it holds the live CRUD runtime). The client receives only the snapshot
 * produced by {@link toSnapshot}.
 */
export type GenerationSession = {
  id: string;
  /** A short human label for the run (the prompt, file name, or DB name). */
  label: string;
  status: SessionStatus;
  /** The most recent stage published by the orchestrator (Req 9.2). */
  stage: GenerationStage;
  /** Ordered history of stage transitions, for a progress timeline. */
  stageHistory: StageEvent[];
  /** The "30s not guaranteed" notice, when the model has > 10 entities (Req 9.5). */
  notice?: string;
  /** The failing stage + reason when the run fails (Req 9.2). */
  failure?: { stage: GenerationStage; reason: string };
  /** The live backend, present only when `status === 'deployed'`. Server-only. */
  backend?: Backend;
  /** Outcome of loading the document's rows into the live database (Postgres deploys). */
  dataPersistence?: { schema: string; ok: boolean; detail?: unknown; error?: string };
  createdAt: number;
};

/**
 * The client-facing, JSON-serializable view of a session. Never includes the
 * live backend; instead it exposes the dashboard descriptor and entity list the
 * UI renders from.
 */
export type SessionSnapshot = {
  id: string;
  status: SessionStatus;
  stage: GenerationStage;
  stageHistory: StageEvent[];
  notice?: string;
  failure?: { stage: GenerationStage; reason: string };
  ready: boolean;
  label?: string;
  dashboard?: DashboardDescriptor;
  entities?: string[];
  /** Live-database data-load summary for Postgres deploys (rows persisted to RDS). */
  dataPersistence?: { schema: string; ok: boolean; detail?: unknown; error?: string };
};

// ---------------------------------------------------------------------------
// Process-local session store
// ---------------------------------------------------------------------------

/**
 * A module-level Map persists across requests within a single server process.
 * Stashed on `globalThis` so Next's dev-mode module reloading does not wipe
 * in-flight sessions.
 */
const SESSIONS: Map<string, GenerationSession> = (() => {
  const g = globalThis as unknown as {
    __adaArchitectSessions?: Map<string, GenerationSession>;
  };
  if (!g.__adaArchitectSessions) {
    g.__adaArchitectSessions = new Map<string, GenerationSession>();
  }
  return g.__adaArchitectSessions;
})();

function newId(): string {
  return `gen_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

// ---------------------------------------------------------------------------
// Public API used by the route handlers
// ---------------------------------------------------------------------------

/**
 * Run a generation to completion (prompt, document, or import) and return the
 * finished session. Unlike a fire-and-forget background job, this **awaits** the
 * full pipeline — which is required on serverless platforms (e.g. Vercel),
 * where background work is killed once the response is sent and in-memory state
 * is not shared across invocations.
 *
 * For a live database deploy the session is keyed by the deployed schema name
 * (`gen_<id>`), so any later request — even on a different serverless instance —
 * can reconstruct it from the database via {@link getOrReopenSession}.
 */
export async function startGeneration(
  input: JobInput,
  label: string,
): Promise<GenerationSession> {
  const tempId = newId();
  const session: GenerationSession = {
    id: tempId,
    label,
    status: 'running',
    stage: 'SUBMITTED',
    stageHistory: [{ stage: 'SUBMITTED', at: Date.now() }],
    createdAt: Date.now(),
  };

  const { pipeline } = createPipelineFromEnv(process.env, {
    observer: {
      onStageTransition: (event) => {
        session.stage = event.stage;
        session.stageHistory.push({ stage: event.stage, at: Date.now() });
      },
      onNotice: (event) => {
        session.notice = event.message;
      },
    },
  });

  try {
    const { job, backend, dataPersistence, deployedSchema } = await pipeline.run(input);
    session.status = job.status === 'deployed' ? 'deployed' : 'failed';
    session.stage = job.currentStage;
    if (job.failure) session.failure = job.failure;
    if (backend) session.backend = backend;
    if (dataPersistence) session.dataPersistence = dataPersistence;

    // Key the session by its deployed schema so it is reconstructable from the
    // database on any instance (serverless-safe). Every successful live deploy
    // reports `deployedSchema` — even prompt-mode runs with no seed rows — so
    // the returned id is always the schema name a fresh instance can reopen.
    const schema = deployedSchema ?? dataPersistence?.schema;
    if (schema) {
      session.id = schema;
      if (!session.dataPersistence) {
        session.dataPersistence = { schema, ok: true };
      }
    }
  } catch (error) {
    session.status = 'failed';
    session.failure = {
      stage: session.stage,
      reason: error instanceof Error ? error.message : String(error),
    };
  }

  SESSIONS.set(session.id, session);
  return session;
}

/** Look up a tracked session by id (in-memory only). */
export function getSession(id: string): GenerationSession | undefined {
  return SESSIONS.get(id);
}

/**
 * Look up a session, reconstructing it from the live database when it is not in
 * memory (e.g. a different serverless instance handled the request, or the
 * process restarted). For a live deploy the id is the schema name, so the
 * backend can be rebuilt by introspecting that schema.
 */
export async function getOrReopenSession(
  id: string,
): Promise<GenerationSession | undefined> {
  const existing = SESSIONS.get(id);
  if (existing) {
    return existing;
  }
  if (/^gen_[a-z0-9_]+$/i.test(id)) {
    try {
      return await openGeneration(id);
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/** Project a session into its client-facing, serializable snapshot. */
export function toSnapshot(session: GenerationSession): SessionSnapshot {
  const ready = session.status === 'deployed' && session.backend !== undefined;
  return {
    id: session.id,
    status: session.status,
    stage: session.stage,
    stageHistory: session.stageHistory,
    notice: session.notice,
    failure: session.failure,
    ready,
    label: session.label,
    dashboard: ready ? session.backend!.dashboard : undefined,
    entities: ready ? session.backend!.crud.entityNames() : undefined,
    dataPersistence: session.dataPersistence,
  };
}

/**
 * The clarifying questions derived from a deployed session's model
 * (Req 8.1/8.2). Interactive refinement is optional/skippable in this slice
 * (Req 8.6): the questions are surfaced for display and can be skipped, since
 * the pipeline already runs refinement non-interactively. Returns an empty list
 * when the session is not yet deployed.
 */
export function questionsFor(session: GenerationSession): ClarifyingQuestion[] {
  const model: DataModel | undefined = session.backend?.model;
  if (!model) {
    return [];
  }
  return deriveQuestions(model);
}

// ---------------------------------------------------------------------------
// Schema view (for the structure diagram + REST API panel)
// ---------------------------------------------------------------------------

/** A client-safe column in the schema view. */
export type SchemaColumn = {
  name: string;
  dataType: string;
  pk: boolean;
  fk: boolean;
  unique: boolean;
  notNull: boolean;
  /** The referenced entity/attribute when this column is a foreign key. */
  references?: { entity: string; attribute: string };
};

/** A client-safe entity in the schema view. */
export type SchemaEntity = {
  name: string;
  isJoin: boolean;
  primaryKey: string[];
  columns: SchemaColumn[];
};

/** A foreign-key derived relationship edge for the diagram. */
export type SchemaEdge = {
  source: string;
  target: string;
  cardinality: string;
  /** The foreign-key column on the source entity. */
  via: string;
};

/** The complete client-safe schema view powering the diagram + API panel. */
export type SchemaView = {
  entities: SchemaEntity[];
  relationships: SchemaEdge[];
};

/**
 * Project a deployed session's Data_Model into the client-safe {@link SchemaView}
 * used by the structure diagram and the REST API panel. Relationship edges are
 * derived from foreign-key constraints (source = FK-holding entity, target =
 * referenced entity), with cardinality taken from the model's relationships
 * when available.
 */
export function buildSchemaView(session: GenerationSession): SchemaView | undefined {
  const model = session.backend?.model;
  if (!model) {
    return undefined;
  }

  const entities: SchemaEntity[] = model.entities.map((e) => {
    const pk = new Set(e.primaryKey);
    return {
      name: e.name,
      isJoin: e.isJoinEntity === true,
      primaryKey: [...e.primaryKey],
      columns: e.attributes.map((a) => {
        const fkc = a.constraints.find((c) => c.kind === 'FOREIGN_KEY');
        return {
          name: a.name,
          dataType: a.dataType,
          pk: pk.has(a.name) || a.constraints.some((c) => c.kind === 'PRIMARY_KEY'),
          fk: fkc !== undefined,
          unique: a.constraints.some((c) => c.kind === 'UNIQUE'),
          notNull: a.constraints.some((c) => c.kind === 'NOT_NULL'),
          references:
            fkc && fkc.kind === 'FOREIGN_KEY' ? { ...fkc.references } : undefined,
        };
      }),
    };
  });

  // Cardinality lookup from the model's declared relationships.
  const cardinalityOf = new Map<string, string>();
  for (const r of model.relationships) {
    cardinalityOf.set(`${r.source}\u0000${r.target}`, r.cardinality);
  }

  const relationships: SchemaEdge[] = [];
  for (const e of model.entities) {
    for (const a of e.attributes) {
      for (const c of a.constraints) {
        if (c.kind === 'FOREIGN_KEY') {
          relationships.push({
            source: e.name,
            target: c.references.entity,
            cardinality: cardinalityOf.get(`${e.name}\u0000${c.references.entity}`) ?? 'ONE_TO_MANY',
            via: a.name,
          });
        }
      }
    }
  }

  return { entities, relationships };
}

// ---------------------------------------------------------------------------
// Saved-backend history (persisted generation schemas in the live database)
// ---------------------------------------------------------------------------

/** A summary of one previously generated backend that still lives in the DB. */
export type SavedGeneration = {
  /** The Postgres schema the generation was deployed into (`gen_<id>`). */
  schema: string;
  /** The entities (tables) and their current row counts. */
  tables: { name: string; rows: number }[];
  /** Whether a live in-process session is currently open for this schema. */
  open: boolean;
};

/** Build the live-database credentials from the environment, or null. */
function dbCredsFromEnv(): DbCredentials | null {
  const host = process.env.AIDA_DB_HOST;
  const database = process.env.AIDA_DB_NAME;
  const user = process.env.AIDA_DB_USER;
  const password = process.env.AIDA_DB_PASSWORD;
  if (!host || !database || !user || !password) {
    return null;
  }
  return {
    host,
    database,
    user,
    password,
    port: Number(process.env.AIDA_DB_PORT ?? 5432),
  };
}

/** A pooled pg client for registry queries (reused across requests). */
async function registryPool(): Promise<{
  query(sql: string, values?: unknown[]): Promise<{ rows: any[] }>;
} | null> {
  const creds = dbCredsFromEnv();
  if (!creds) return null;
  const g = globalThis as unknown as { __aidaRegistryPool?: any };
  if (g.__aidaRegistryPool) return g.__aidaRegistryPool;
  const pg = (await import('pg')) as unknown as {
    Pool: new (config: Record<string, unknown>) => any;
  };
  g.__aidaRegistryPool = new pg.Pool({
    host: creds.host,
    port: creds.port,
    database: creds.database,
    user: creds.user,
    password: creds.password,
    ssl: { rejectUnauthorized: false },
    max: 3,
  });
  return g.__aidaRegistryPool;
}

/** A schema that already has a live in-process session, keyed by schema name. */
function openSchemas(): Set<string> {
  const open = new Set<string>();
  for (const s of SESSIONS.values()) {
    if (s.dataPersistence?.schema) open.add(s.dataPersistence.schema);
  }
  return open;
}

/**
 * List every previously generated backend that still exists in the live
 * database (the `gen_*` schemas), newest first, with each entity's row count.
 * Returns an empty list when no live database is configured.
 */
export async function listGenerations(): Promise<SavedGeneration[]> {
  const pool = await registryPool();
  if (!pool) return [];

  const schemas = await pool.query(
    `SELECT schema_name FROM information_schema.schemata
     WHERE schema_name LIKE 'gen_%' ORDER BY schema_name DESC`,
  );
  const open = openSchemas();
  const out: SavedGeneration[] = [];
  for (const { schema_name: schema } of schemas.rows) {
    const tables = await pool.query(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = $1 ORDER BY table_name`,
      [schema],
    );
    const tableInfo: { name: string; rows: number }[] = [];
    for (const { table_name } of tables.rows) {
      const c = await pool.query(
        `SELECT count(*)::int AS n FROM "${schema}"."${table_name}"`,
      );
      tableInfo.push({ name: table_name, rows: c.rows[0]?.n ?? 0 });
    }
    out.push({ schema, tables: tableInfo, open: open.has(schema) });
  }
  return out;
}

/**
 * Reopen a previously generated backend: introspect its live `gen_<id>` schema
 * back into a Data_Model, rebuild the CRUD runtime + dashboard descriptor over
 * it, and register a deployed session bound to that schema so the dashboard
 * reads and writes the real database. Returns the new session, or throws when
 * no live database is configured or the schema has no tables.
 */
export async function openGeneration(schema: string): Promise<GenerationSession> {
  const creds = dbCredsFromEnv();
  if (!creds) {
    throw new Error('No live database is configured (AIDA_DB_* not set).');
  }
  if (!/^gen_[a-z0-9_]+$/i.test(schema)) {
    throw new Error(`Invalid schema name "${schema}".`);
  }

  // If a session is already open for this schema, reuse it.
  for (const s of SESSIONS.values()) {
    if (s.dataPersistence?.schema === schema && s.backend) {
      return s;
    }
  }

  const analyzer = new SourceImportAnalyzer(new PgSource({ schema }));
  const result = await analyzer.importSchema(creds);
  if (!result.ok) {
    throw new Error(`Could not read schema "${schema}": ${result.error.message}`);
  }
  const model = result.value.model;
  if (model.entities.length === 0) {
    throw new Error(`Schema "${schema}" has no tables to open.`);
  }

  const backend: Backend = {
    model,
    apiSurface: generateApiSurface(model),
    crud: buildCrudSet(model),
    dashboard: generateDescriptor(model),
    auth: new AuthService(),
  };

  const id = schema;
  const now = Date.now();
  const session: GenerationSession = {
    id,
    label: `Reopened: ${schema}`,
    status: 'deployed',
    stage: 'DEPLOYED',
    stageHistory: [{ stage: 'DEPLOYED', at: now }],
    backend,
    dataPersistence: { schema, ok: true },
    createdAt: now,
  };
  SESSIONS.set(id, session);
  return session;
}
