/**
 * GenerationPipeline — the [MUST] vertical-slice wiring (task 12.1).
 *
 * This module connects the real components of the backend engine onto the
 * {@link Orchestrator}'s narrow stage *ports* and exposes a single high-level
 * entry, {@link GenerationPipeline.run}, that drives one input all the way to a
 * live backend + dashboard descriptor:
 *
 *   Modeling_Engine -> Refinement_Engine -> Schema_Generator
 *     -> Round-Trip Verifier (deploy gate) -> Provisioner
 *     -> API_Generator / Auth / Dashboard
 *
 * Design principle: the Orchestrator owns the state machine, stage publishing,
 * timeouts, and compensation (tasks 11.1/11.2). It depends only on the abstract
 * ports declared in `orchestrator.ts`. This module supplies the adapters that
 * map each concrete component onto its port, flattening every component's typed
 * error taxonomy into the uniform {@link PortError} (`{ message, detail }`).
 *
 * ## Adapter mapping (component -> port)
 *
 * | Stage      | Port                  | Backing component                         |
 * | ---------- | --------------------- | ----------------------------------------- |
 * | MODELING   | ModelingPort          | {@link ModelingEngine.inferFromPrompt}    |
 * | REFINING   | RefinementPort        | {@link RefinementEngine.applyAnswers}([]) |
 * | SCHEMA_GEN | SchemaGeneratorPort   | {@link generateSchema}(model,'POSTGRES')  |
 * | VERIFYING  | RoundTripVerifierPort | {@link DefaultRoundTripVerifier.verify}   |
 * | DEPLOYING  | ProvisionerPort       | {@link TransactionalProvisioner.apply}    |
 * | API_GEN    | ApiGeneratorPort      | {@link buildCrudSet} + {@link generateDescriptor} + {@link AuthService} |
 *
 * ## The deploy gate (Req 12.5)
 *
 * The Round-Trip Verifier adapter is the deploy gate: if `verify` reports a
 * round-trip diff, the adapter returns an `err(PortError)`, so the Orchestrator
 * fails the job at the VERIFYING stage and never advances to DEPLOYING. A lossy
 * schema can therefore never reach the live target.
 *
 * ## Compensation (Req 9.4)
 *
 * A {@link CompensationPort} is supplied so that, on a hard-timeout, any
 * partially produced backend artifacts for the job are discarded: the in-memory
 * record store is cleared and the captured backend reference is dropped, so no
 * Data_Model is left in `deployed` status.
 *
 * ## Local/demo wiring & dependency injection
 *
 * Everything is dependency-injectable so tests can drive the pipeline
 * deterministically:
 * - The default LLM client is a {@link StubLlmClient} — no live LLM dependency.
 *   Inject a real {@link LlmClient} to use a hosted model.
 * - The default Provisioner is backed by an {@link InMemoryDriver} (a
 *   transactional fake) targeting a local {@link DeploymentTarget}, so `run`
 *   works end to end without live AWS. Inject a real driver/target for a live
 *   deploy.
 * - The Orchestrator clock and id generator are injectable for deterministic
 *   timeout/identity tests.
 */
import { ok, err } from '../model/result.js';
import { Orchestrator, } from '../orchestrator/orchestrator.js';
import { ModelingEngine } from '../modeling/modelingEngine.js';
import { StubLlmClient } from '../modeling/llmClient.js';
import { RefinementEngine } from '../refinement/refinementEngine.js';
import { DocumentParser, } from '../document/documentParser.js';
import { xlsxExtractor, xlsxSheets, extractPdfRecords } from '../document/extractors.js';
import { SourceImportAnalyzer, } from '../import/importAnalyzer.js';
import { PgSource } from '../import/pgSource.js';
import { MySqlSource } from '../import/mysqlSource.js';
import { readPostgresRows } from '../import/pgDataReader.js';
import { readMySqlRows } from '../import/mysqlDataReader.js';
import { generate as generateSchema } from '../schema/schemaGenerator.js';
import { DefaultRoundTripVerifier } from '../schema/roundTripVerifier.js';
import { TransactionalProvisioner, } from '../provisioner/provisioner.js';
import { systemClock } from '../provisioner/driver.js';
import { InMemoryDriver } from '../provisioner/inMemoryDriver.js';
import { buildCrudSet, createInMemoryStore, } from '../api/crudRuntime.js';
import { generate as generateApiSurface, } from '../api/apiGenerator.js';
import { generateDescriptor, } from '../dashboard/descriptor.js';
import { AuthService } from '../auth/authService.js';
// ---------------------------------------------------------------------------
// Default local Deployment_Target
// ---------------------------------------------------------------------------
/**
 * A placeholder Deployment_Target used for local/demo runs. The default
 * {@link InMemoryDriver} ignores the credentials (they only appear in
 * connectivity messages), so this lets `run` complete end to end without a live
 * AWS connection. Provide a real target (and a real driver) to deploy for real.
 */
export const LOCAL_DEPLOYMENT_TARGET = {
    kind: 'POSTGRES',
    connection: {
        host: 'localhost',
        port: 5432,
        database: 'ai_database_architect_local',
        user: 'local',
        password: 'local',
    },
};
/** A unique, valid PostgreSQL schema name for one generation's live deploy. */
function generateSchemaName(prefix = 'gen') {
    const stamp = Date.now().toString(36);
    const rand = Math.random().toString(36).slice(2, 6) + Math.random().toString(36).slice(2, 6);
    return `${prefix}_${stamp}_${rand}`;
}
/**
 * Order entities so that a referenced (parent) entity comes before any entity
 * whose foreign key points at it. Used when seeding imported data so parent
 * rows are inserted before the child rows that reference them, satisfying the
 * migrated schema's foreign keys. Falls back to model order on a cycle.
 */
function topologicalEntityOrder(model) {
    const names = model.entities.map((e) => e.name);
    // dependsOn[source] = set of targets the source's FKs reference.
    const dependsOn = new Map();
    for (const name of names)
        dependsOn.set(name, new Set());
    for (const rel of model.relationships) {
        // rel.source holds the FK referencing rel.target -> source depends on target.
        if (dependsOn.has(rel.source) && names.includes(rel.target) && rel.source !== rel.target) {
            dependsOn.get(rel.source).add(rel.target);
        }
    }
    const ordered = [];
    const placed = new Set();
    // Repeatedly place any entity whose dependencies are all already placed.
    let progress = true;
    while (ordered.length < names.length && progress) {
        progress = false;
        for (const name of names) {
            if (placed.has(name))
                continue;
            const deps = dependsOn.get(name);
            if ([...deps].every((d) => placed.has(d))) {
                ordered.push(name);
                placed.add(name);
                progress = true;
            }
        }
    }
    // Any remaining (cycle) appended in model order.
    for (const name of names) {
        if (!placed.has(name))
            ordered.push(name);
    }
    return ordered;
}
// ---------------------------------------------------------------------------
// Adapters: concrete component -> Orchestrator port
// ---------------------------------------------------------------------------
/**
 * MODELING adapter — the entry point for all three "ways to create a backend".
 * Routes by input kind, each producing a `DataModel` the rest of the pipeline
 * treats identically:
 *  - PROMPT   → {@link ModelingEngine.inferFromPrompt} (LLM inference).
 *  - DOCUMENT → parse the upload (CSV/Excel via {@link DocumentParser}, PDF via
 *    {@link extractPdfRecords}) then {@link ModelingEngine.inferFromRecords}
 *    (relational decomposition, Req 10).
 *  - IMPORT   → introspect an existing PostgreSQL/MySQL database via the
 *    {@link ImportAnalyzer} and migrate its schema (Req 11).
 * Every component error is flattened to a {@link PortError}.
 */
class ModelingAdapter {
    engine;
    documentParser;
    makeImportAnalyzer;
    seedRef;
    constructor(engine, documentParser, makeImportAnalyzer, seedRef) {
        this.engine = engine;
        this.documentParser = documentParser;
        this.makeImportAnalyzer = makeImportAnalyzer;
        this.seedRef = seedRef;
    }
    async infer(input) {
        switch (input.kind) {
            case 'PROMPT':
                return this.fromModeling(this.engine.inferFromPrompt(input.prompt));
            case 'DOCUMENT':
                return this.fromDocument(input);
            case 'IMPORT':
                return this.fromImport(input);
            default: {
                const _exhaustive = input;
                void _exhaustive;
                return err({ message: 'Unsupported input kind' });
            }
        }
    }
    /** DOCUMENT path: extract records (CSV/Excel/PDF) then infer a model. */
    async fromDocument(input) {
        const doc = input.document;
        const bytes = doc.encoding === 'base64'
            ? new Uint8Array(Buffer.from(doc.content, 'base64'))
            : undefined;
        let records;
        try {
            if (isPdf(doc.name, doc.format, doc.contentType)) {
                if (bytes === undefined) {
                    return err({ message: 'PDF upload must be base64-encoded' });
                }
                records = await extractPdfRecords(bytes);
                if (records.length === 0) {
                    return err({
                        message: 'No tabular records could be extracted from the PDF.',
                    });
                }
            }
            else if (isExcel(doc.name, doc.format, doc.contentType)) {
                // Multi-sheet workbooks: each sheet becomes its own related entity.
                const file = {
                    name: doc.name,
                    format: doc.format,
                    contentType: doc.contentType,
                    content: bytes ?? doc.content,
                };
                const sheets = xlsxSheets(file);
                if (sheets.length === 0) {
                    return err({ message: 'No records were found in the workbook.' });
                }
                if (sheets.length > 1) {
                    return this.fromModelingAndSeed(this.engine.inferAndSeedFromSheets(sheets));
                }
                records = sheets[0].records;
            }
            else {
                const file = {
                    name: doc.name,
                    format: doc.format,
                    contentType: doc.contentType,
                    content: bytes ?? doc.content,
                };
                const parsed = this.documentParser.parse(file);
                if (!parsed.ok) {
                    return err({ message: parsed.error.message, detail: parsed.error });
                }
                records = parsed.value;
            }
        }
        catch (error) {
            return err({
                message: `Failed to parse the uploaded document: ${error instanceof Error ? error.message : String(error)}`,
            });
        }
        return this.fromModelingAndSeed(this.engine.inferAndSeedFromRecords(records));
    }
    /** IMPORT path: introspect an existing database into a model. */
    async fromImport(input) {
        const analyzer = this.makeImportAnalyzer(input.engine);
        const result = await analyzer.importSchema(input.connection);
        if (!result.ok) {
            return err({ message: result.error.message, detail: result.error });
        }
        const model = result.value.model;
        if (model.entities.length === 0) {
            return err({
                message: 'The source database has no tables to import.',
            });
        }
        // Copy the source DATA (not just the schema) so the migrated backend
        // actually contains the rows from the old system. Best-effort; a failure
        // here leaves the migrated tables empty but never fails the import. Rows
        // are ordered so referenced (parent) tables seed before the tables whose
        // foreign keys point at them.
        try {
            const names = model.entities.map((e) => e.name);
            const raw = input.engine === 'mysql'
                ? await readMySqlRows(input.connection, names)
                : await readPostgresRows(input.connection, 'public', names);
            const seed = new Map();
            for (const entityName of topologicalEntityOrder(model)) {
                const rows = raw.get(entityName);
                if (rows !== undefined && rows.length > 0) {
                    seed.set(entityName, rows);
                }
            }
            if (seed.size > 0) {
                this.seedRef.seed = seed;
            }
        }
        catch {
            // Schema-only fallback: migrated tables arrive empty.
        }
        return ok(model);
    }
    /** Flatten a ModelingEngine Result into a PortResult. */
    async fromModeling(promise) {
        const result = await promise;
        if (result.ok) {
            return ok(result.value);
        }
        return err({ message: result.error.message, detail: result.error });
    }
    /**
     * Flatten a model+seed Result into a PortResult, capturing the seed rows into
     * {@link seedRef} so the API_GEN stage can load the document's actual records
     * into the generated backend. On error the seed is left unset.
     */
    async fromModelingAndSeed(promise) {
        const result = await promise;
        if (result.ok) {
            this.seedRef.seed = result.value.seed;
            return ok(result.value.model);
        }
        return err({ message: result.error.message, detail: result.error });
    }
}
/** Detect a PDF upload from its name/format/content-type. */
function isPdf(name, format, contentType) {
    return ((format ?? '').toLowerCase() === 'pdf' ||
        (contentType ?? '').toLowerCase() === 'application/pdf' ||
        name.toLowerCase().endsWith('.pdf'));
}
/** Detect an Excel upload from its name/format/content-type. */
function isExcel(name, format, contentType) {
    const fmt = (format ?? '').toLowerCase();
    const ct = (contentType ?? '').toLowerCase();
    const lower = name.toLowerCase();
    return (fmt === 'xlsx' ||
        fmt === 'xls' ||
        fmt === 'excel' ||
        ct === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' ||
        ct === 'application/vnd.ms-excel' ||
        lower.endsWith('.xlsx') ||
        lower.endsWith('.xls'));
}
/**
 * REFINING adapter. Non-interactive default: applies an empty answer set, which
 * returns the model unchanged (Req 8.6). This keeps the end-to-end run fully
 * automatic. A conflict cannot arise from an empty answer set, but the error
 * branch is mapped to a {@link PortError} for completeness.
 */
class RefinementAdapter {
    engine;
    constructor(engine) {
        this.engine = engine;
    }
    async refine(model) {
        const result = this.engine.applyAnswers(model, []);
        if (result.ok) {
            return ok(result.value);
        }
        return err({ message: result.error.message, detail: result.error });
    }
}
/**
 * SCHEMA_GEN adapter. Projects the accepted model to a POSTGRES migration
 * script, flattening any `SchemaGenError` to a {@link PortError} (Req 3.x).
 */
class SchemaGeneratorAdapter {
    async generate(model) {
        const result = generateSchema(model, 'POSTGRES');
        if (result.ok) {
            return ok(result.value);
        }
        return err({ message: result.error.message, detail: result.error });
    }
}
/**
 * VERIFYING adapter — the deploy gate (Req 12.5). Runs the Round-Trip Verifier
 * and, on any structural diff, returns an `err(PortError)` so the Orchestrator
 * fails at VERIFYING and never reaches DEPLOYING.
 */
class RoundTripVerifierAdapter {
    verifier;
    constructor(verifier) {
        this.verifier = verifier;
    }
    async verify(migration, source) {
        const result = this.verifier.verify(migration, source);
        if (result.ok) {
            return ok(undefined);
        }
        return err({
            message: `Round-trip verification failed: ${result.error.message}`,
            detail: result.error,
        });
    }
}
/**
 * DEPLOYING adapter. Applies the verified migration to the injected target via
 * the {@link Provisioner}, mapping a `failed` {@link DeployResult} to an
 * `err(PortError)` and a `deployed` result to `ok` (Req 4).
 */
class ProvisionerAdapter {
    provisioner;
    target;
    constructor(provisioner, target) {
        this.provisioner = provisioner;
        this.target = target;
    }
    async apply(migration) {
        const result = await this.provisioner.apply(migration, this.target);
        if (result.status === 'deployed') {
            return ok(undefined);
        }
        return err({
            message: result.reason,
            detail: { cause: result.cause },
        });
    }
}
/**
 * API_GEN adapter. This is where the API_Generator, the CRUD runtime, the
 * Auth_Service, and the Admin_Dashboard descriptor come together into a single
 * live backend (Req 5.1, 6.6, 7.1). The produced {@link Backend} is recorded
 * into the supplied `backendRef` holder so the pipeline can expose it alongside
 * the job after a successful run.
 */
class ApiGeneratorAdapter {
    store;
    auth;
    backendRef;
    seedRef;
    constructor(store, auth, backendRef, seedRef) {
        this.store = store;
        this.auth = auth;
        this.backendRef = backendRef;
        this.seedRef = seedRef;
    }
    async generate(model) {
        const apiSurface = generateApiSurface(model);
        const crud = buildCrudSet(model, this.store);
        const dashboard = generateDescriptor(model);
        // Load any document-derived seed rows into the live store so the generated
        // backend serves the source data (Req 10). Referenced (group) entities are
        // ordered before the main entity in the seed map, so foreign-key existence
        // checks pass. Seeding is best-effort: a row that violates a constraint is
        // skipped rather than aborting the whole run.
        const seed = this.seedRef.seed;
        if (seed !== undefined) {
            for (const [entityName, rows] of seed) {
                const entityCrud = crud.get(entityName);
                if (entityCrud === undefined) {
                    continue;
                }
                for (const row of rows) {
                    entityCrud.create(row);
                }
            }
        }
        this.backendRef.backend = {
            model,
            apiSurface,
            crud,
            dashboard,
            auth: this.auth,
        };
        return ok(undefined);
    }
}
/**
 * Compensation handler (Req 9.4). On a hard-timeout the Orchestrator invokes
 * this to discard partial artifacts. Because the local provisioner is
 * transactional and a per-run store is used, compensation drops the applied
 * schema for the job by clearing the in-memory store and the captured backend
 * reference, ensuring no Data_Model is left in `deployed` status.
 */
class BackendCompensation {
    store;
    backendRef;
    constructor(store, backendRef) {
        this.store = store;
        this.backendRef = backendRef;
    }
    async compensate(job) {
        // Drop any persisted records for the (possibly partially) deployed model
        // and forget the captured backend so nothing remains "deployed".
        const model = this.backendRef.backend?.model ?? job.model;
        if (model !== undefined) {
            for (const entity of model.entities) {
                for (const { key } of this.store.entries(entity.name)) {
                    this.store.delete(entity.name, key);
                }
            }
        }
        this.backendRef.backend = undefined;
    }
}
// ---------------------------------------------------------------------------
// GenerationPipeline
// ---------------------------------------------------------------------------
/**
 * The single high-level entry point for the [MUST] vertical slice. Builds the
 * adapter graph, drives one input through the Orchestrator, and returns the
 * final job plus the live backend (when deployed).
 *
 * A fresh adapter graph, record store, and Orchestrator are constructed per
 * {@link run} call so concurrent runs never share mutable state and the
 * per-run backend/compensation references stay isolated.
 */
export class GenerationPipeline {
    deps;
    options;
    constructor(deps = {}, options = {}) {
        this.deps = deps;
        this.options = options;
    }
    /**
     * Run a single Generation_Job end to end. Resolves with the final
     * {@link GenerationJob} and, on success, the live {@link Backend}. On any
     * failure (deploy-gate rejection, provisioning failure, or timeout) the job
     * carries the failing stage/reason and `backend` is `undefined`.
     */
    async run(input) {
        // Per-run mutable state: an isolated store and a holder the API_GEN adapter
        // writes the produced backend into.
        const store = createInMemoryStore();
        const backendRef = {};
        // Holds document-derived seed rows captured at MODELING and consumed at
        // API_GEN so the generated backend serves the uploaded document's data.
        const seedRef = {};
        // Build (or reuse injected) components.
        const llmClient = this.deps.llmClient ?? new StubLlmClient();
        const modelingEngine = new ModelingEngine(llmClient);
        const refinementEngine = new RefinementEngine();
        const verifier = new DefaultRoundTripVerifier();
        const auth = this.deps.authService ?? new AuthService();
        // Document parsing: CSV built in, Excel via SheetJS; PDF handled in the
        // adapter's async path. Import: Postgres or MySQL source by engine.
        const documentParser = new DocumentParser({ excelExtractor: xlsxExtractor });
        const makeImportAnalyzer = (engine) => new SourceImportAnalyzer(engine === 'mysql' ? new MySqlSource() : new PgSource());
        const modelingAdapter = new ModelingAdapter(modelingEngine, documentParser, makeImportAnalyzer, seedRef);
        const target = this.deps.deploymentTarget ?? LOCAL_DEPLOYMENT_TARGET;
        // When a per-run provisioner factory is supplied (live Postgres deploys),
        // isolate this generation into its own schema and bind the provisioner to
        // it, so the same schema can be seeded with the document's rows afterward.
        const deployedSchema = this.deps.makeProvisioner !== undefined ? generateSchemaName() : undefined;
        const provisioner = deployedSchema !== undefined && this.deps.makeProvisioner !== undefined
            ? this.deps.makeProvisioner(deployedSchema)
            : this.deps.provisioner ??
                new TransactionalProvisioner(new InMemoryDriver(), this.deps.provisionerClock ?? systemClock);
        const orchestrator = new Orchestrator({
            modeling: modelingAdapter,
            refinement: new RefinementAdapter(refinementEngine),
            schemaGenerator: new SchemaGeneratorAdapter(),
            verifier: new RoundTripVerifierAdapter(verifier),
            provisioner: new ProvisionerAdapter(provisioner, target),
            apiGenerator: new ApiGeneratorAdapter(store, auth, backendRef, seedRef),
            compensation: new BackendCompensation(store, backendRef),
        }, this.options);
        const job = await orchestrator.run(input);
        // Expose the backend only when the run actually reached `deployed`.
        const backend = job.status === 'deployed' ? backendRef.backend : undefined;
        // Persist the document-derived rows into the live database so the deployed
        // backend's schema actually contains the uploaded data (not just empty
        // tables). Only when we deployed into a known schema, have a seeder, and
        // have seed rows. A data-load failure does not un-deploy the schema; it is
        // reported via `dataPersistence` rather than failing the whole run.
        let dataPersistence;
        if (job.status === 'deployed' &&
            deployedSchema !== undefined &&
            this.deps.persistSeed !== undefined &&
            seedRef.seed !== undefined &&
            backend !== undefined) {
            try {
                const detail = await this.deps.persistSeed(deployedSchema, backend.model, seedRef.seed);
                dataPersistence = { schema: deployedSchema, ok: true, detail };
            }
            catch (error) {
                dataPersistence = {
                    schema: deployedSchema,
                    ok: false,
                    error: error instanceof Error ? error.message : String(error),
                };
            }
        }
        // Best-effort post-deploy optimization (e.g. search/filter indexes). Never
        // affects the deploy outcome; failures are ignored.
        if (job.status === 'deployed' &&
            deployedSchema !== undefined &&
            this.deps.optimize !== undefined &&
            backend !== undefined) {
            try {
                await this.deps.optimize(deployedSchema, backend.model);
            }
            catch {
                // Optimization is advisory; ignore failures.
            }
        }
        return { job, backend, dataPersistence };
    }
}
/**
 * Convenience: build a pipeline whose Modeling_Engine is driven by a stub LLM
 * returning the given raw candidate model (or a prompt-derived one). Useful for
 * demos and tests that want a deterministic model without constructing the LLM
 * client by hand.
 */
export function createStubPipeline(stub, options = {}) {
    return new GenerationPipeline({ llmClient: new StubLlmClient(stub) }, options);
}
//# sourceMappingURL=pipeline.js.map