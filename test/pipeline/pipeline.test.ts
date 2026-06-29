/**
 * Focused unit tests for the wired GenerationPipeline (task 12.1).
 *
 * These exercise the end-to-end wiring through the orchestrator:
 *  - a successful run produces a live backend + dashboard descriptor;
 *  - the round-trip verifier truly gates deploy (a mismatch fails at VERIFYING
 *    and never reaches DEPLOYING);
 *  - an injected provisioning failure fails closed at DEPLOYING with no backend;
 *  - a hard timeout fails closed and exposes no backend (compensation, Req 9.4).
 */

import { describe, it, expect } from 'vitest';
import {
  GenerationPipeline,
  createStubPipeline,
  LOCAL_DEPLOYMENT_TARGET,
} from '../../src/pipeline/pipeline.js';
import {
  StubLlmClient,
  type RawCandidateModel,
} from '../../src/modeling/llmClient.js';
import type {
  DataModel,
  DeployResult,
  DeploymentTarget,
  JobInput,
  MigrationScript,
} from '../../src/model/types.js';
import {
  Orchestrator,
  HARD_CEILING_MS,
  type SchemaGeneratorPort,
  type PortResult,
} from '../../src/orchestrator/orchestrator.js';
import { ok, err } from '../../src/model/result.js';
import type { Provisioner } from '../../src/provisioner/provisioner.js';
import { ModelingEngine } from '../../src/modeling/modelingEngine.js';
import { RefinementEngine } from '../../src/refinement/refinementEngine.js';
import { DefaultRoundTripVerifier } from '../../src/schema/roundTripVerifier.js';

/** A small, well-formed raw candidate the modeling engine can normalize. */
const HOTEL_CANDIDATE: RawCandidateModel = {
  entities: [
    {
      name: 'Guest',
      attributes: [
        { name: 'email', dataType: 'TEXT', unique: true, required: true },
        { name: 'name', dataType: 'TEXT', required: true },
      ],
    },
    {
      name: 'Booking',
      attributes: [{ name: 'nights', dataType: 'INTEGER', required: true }],
    },
  ],
  relationships: [
    { source: 'Booking', target: 'Guest', cardinality: 'one-to-many' },
  ],
};

const PROMPT: JobInput = {
  kind: 'PROMPT',
  prompt: 'Build a hotel booking system',
};

describe('GenerationPipeline.run (happy path)', () => {
  it('drives a prompt to a deployed live backend + dashboard descriptor', async () => {
    const pipeline = createStubPipeline(HOTEL_CANDIDATE);

    const { job, backend } = await pipeline.run(PROMPT);

    expect(job.status).toBe('deployed');
    expect(job.currentStage).toBe('DEPLOYED');
    expect(job.migration?.target).toBe('POSTGRES');

    expect(backend).toBeDefined();
    if (backend === undefined) {
      throw new Error('expected a backend');
    }

    // API surface + CRUD runtime cover every entity (Req 5.1).
    const entityNames = backend.crud.entityNames();
    expect(entityNames).toContain('Guest');
    expect(entityNames).toContain('Booking');

    // Dashboard descriptor lists exactly the model's entities (Req 7.1).
    const dashEntities = backend.dashboard.entities.map((e) => e.entityName);
    expect(new Set(dashEntities)).toEqual(
      new Set(backend.model.entities.map((e) => e.name)),
    );

    // Auth is wired into the backend with role-based access (Req 6.6).
    expect(backend.auth.signup('admin@x.io', 'pw', 'admin').ok).toBe(true);

    // The CRUD runtime actually works end to end.
    const guest = backend.crud.get('Guest');
    expect(guest).toBeDefined();
    expect(guest!.create({ email: 'a@b.com', name: 'Ann' }).ok).toBe(true);
  });

  it('builds a backend from a CSV document upload (Document → Backend)', async () => {
    const pipeline = createStubPipeline(HOTEL_CANDIDATE);
    const csv = [
      'studentId,studentName,facultyName,facultyDept',
      'S1,Ann,Dr. Smith,Biology',
      'S2,Bob,Dr. Smith,Biology',
      'S3,Cara,Dr. Lee,Physics',
    ].join('\n');
    const { job, backend } = await pipeline.run({
      kind: 'DOCUMENT',
      document: { name: 'attendance.csv', content: csv },
    });

    expect(job.status).toBe('deployed');
    expect(backend).toBeDefined();
    // Repeating {facultyName, facultyDept} group → its own related entity.
    expect((backend?.crud.entityNames().length ?? 0)).toBeGreaterThanOrEqual(2);
  });
});

describe('GenerationPipeline deploy gate (Req 12.5)', () => {
  it('fails at VERIFYING and never deploys when the round trip mismatches', async () => {
    // A schema generator that emits an empty script: zero parsed tables can
    // never match the source entities, so the round-trip verifier rejects it.
    const lossySchemaGen: SchemaGeneratorPort = {
      generate(): PortResult<MigrationScript> {
        return Promise.resolve(ok({ target: 'POSTGRES', statements: [] }));
      },
    };

    let deployCalled = false;
    const modeling = new ModelingEngine(new StubLlmClient(HOTEL_CANDIDATE));
    const refinement = new RefinementEngine();
    const verifier = new DefaultRoundTripVerifier();

    const orchestrator = new Orchestrator({
      modeling: {
        async infer(input) {
          if (input.kind !== 'PROMPT') return err({ message: 'no' });
          const r = await modeling.inferFromPrompt(input.prompt);
          return r.ok ? ok(r.value) : err({ message: r.error.message });
        },
      },
      refinement: {
        async refine(model: DataModel) {
          const r = refinement.applyAnswers(model, []);
          return r.ok ? ok(r.value) : err({ message: r.error.message });
        },
      },
      schemaGenerator: lossySchemaGen,
      verifier: {
        async verify(migration: MigrationScript, source: DataModel) {
          const r = verifier.verify(migration, source);
          return r.ok ? ok(undefined) : err({ message: r.error.message });
        },
      },
      provisioner: {
        async apply() {
          deployCalled = true;
          return ok(undefined);
        },
      },
      apiGenerator: {
        async generate() {
          return ok(undefined);
        },
      },
    });

    const job = await orchestrator.run(PROMPT);

    expect(job.status).toBe('failed');
    expect(job.failure?.stage).toBe('VERIFYING');
    // The gate must block deploy entirely.
    expect(deployCalled).toBe(false);
  });
});

describe('GenerationPipeline provisioning failure (Req 4.3)', () => {
  it('fails closed at DEPLOYING with no backend when the provisioner fails', async () => {
    const failingProvisioner: Provisioner = {
      async apply(
        _script: MigrationScript,
        _target: DeploymentTarget,
      ): Promise<DeployResult> {
        return {
          status: 'failed',
          reason: 'simulated migration failure',
          cause: 'MIGRATION',
        };
      },
    };

    const pipeline = new GenerationPipeline({
      llmClient: new StubLlmClient(HOTEL_CANDIDATE),
      provisioner: failingProvisioner,
      deploymentTarget: LOCAL_DEPLOYMENT_TARGET,
    });

    const { job, backend } = await pipeline.run(PROMPT);

    expect(job.status).toBe('failed');
    expect(job.failure?.stage).toBe('DEPLOYING');
    expect(backend).toBeUndefined();
  });
});

describe('GenerationPipeline compensation (Req 9.4)', () => {
  it('fails closed on a hard timeout with no backend exposed', async () => {
    // A clock that reports time past the hard ceiling after the job's start
    // time is captured, so the first stage boundary check trips the timeout.
    let calls = 0;
    const clock = (): number => {
      calls += 1;
      return calls <= 2 ? 0 : HARD_CEILING_MS + 1;
    };

    const pipeline = new GenerationPipeline(
      { llmClient: new StubLlmClient(HOTEL_CANDIDATE) },
      { clock },
    );

    const { job, backend } = await pipeline.run(PROMPT);

    expect(job.status).toBe('failed');
    expect(job.failure).toBeDefined();
    expect(backend).toBeUndefined();
  });
});
