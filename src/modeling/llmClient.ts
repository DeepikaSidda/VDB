/**
 * The LLM client boundary for the Modeling_Engine.
 *
 * Design principle "Model first, generate second": the LLM never writes DDL,
 * API code, or SQL directly. It is prompted to emit a *raw candidate model* —
 * a loose, untrusted, structured shape — which deterministic post-processing
 * (task 2.2) then normalizes and validates into a well-formed `DataModel`.
 *
 * Only the Modeling_Engine and Refinement_Engine call the LLM at runtime. In
 * property and unit tests the LLM is stubbed (see `StubLlmClient`) so the
 * deterministic logic around it can be exercised across many generated inputs
 * without depending on a non-deterministic external service.
 */

// ---------------------------------------------------------------------------
// Raw candidate model (untrusted LLM output)
// ---------------------------------------------------------------------------

/**
 * The unvalidated model the LLM is asked to emit. Every field is optional and
 * intentionally loose: the LLM may omit primary keys, emit unknown/empty data
 * type strings, produce free-form cardinality labels, or leave names blank.
 *
 * This shape is deliberately NOT the `DataModel` IR. Deterministic
 * post-processing in the Modeling_Engine (task 2.2) is responsible for
 * normalizing a `RawCandidateModel` into a well-formed `DataModel` that
 * satisfies the IR invariants (single PK per entity, supported data types,
 * valid cardinality, materialized M:N join entities, etc.). Nothing here is
 * trusted blindly.
 */
export type RawCandidateModel = {
  entities?: RawCandidateEntity[];
  relationships?: RawCandidateRelationship[];
};

/**
 * A loosely-shaped entity as emitted by the LLM. `primaryKey` may be missing,
 * empty, or contain multiple names; post-processing reconciles this to exactly
 * one primary key per entity.
 */
export type RawCandidateEntity = {
  name?: string;
  attributes?: RawCandidateAttribute[];
  /** May be absent, empty, or list several names; normalized later. */
  primaryKey?: string[];
};

/**
 * A loosely-shaped attribute as emitted by the LLM. `dataType` is a free-form
 * string (not yet constrained to the supported `DataType` set) and the
 * constraint hints are advisory until post-processing decides on them.
 */
export type RawCandidateAttribute = {
  name?: string;
  /** Free-form; normalized to a supported `DataType` in post-processing. */
  dataType?: string;
  /** Advisory hint that the attribute uniquely identifies records. */
  unique?: boolean;
  /** Advisory hint that the attribute must be present. */
  required?: boolean;
};

/**
 * A loosely-shaped relationship as emitted by the LLM. `cardinality` is a
 * free-form string; post-processing maps it onto the three allowed values.
 */
export type RawCandidateRelationship = {
  source?: string;
  target?: string;
  /** Free-form; normalized to ONE_TO_ONE | ONE_TO_MANY | MANY_TO_MANY. */
  cardinality?: string;
};

// ---------------------------------------------------------------------------
// LLM client interface
// ---------------------------------------------------------------------------

/**
 * The narrow boundary the Modeling_Engine uses to talk to an LLM provider.
 *
 * Implementations take a (already-validated) domain prompt and return a raw
 * candidate model. Production implementations call a hosted LLM; tests use a
 * `StubLlmClient`.
 */
export interface LlmClient {
  /**
   * Produce a raw candidate model for the given prompt. The prompt is assumed
   * to have already passed input validation (non-empty, within length).
   */
  generateCandidateModel(prompt: string): Promise<RawCandidateModel>;
}

// ---------------------------------------------------------------------------
// Stub implementation (for tests)
// ---------------------------------------------------------------------------

/**
 * A configurable stand-in for a real LLM, used in property and unit tests.
 *
 * It can be configured with either a fixed `RawCandidateModel` or a function
 * that derives the response from the prompt (useful for property tests that
 * generate arbitrary raw candidate models). It performs no I/O and is fully
 * deterministic given its configuration.
 */
export class StubLlmClient implements LlmClient {
  private readonly response:
    | RawCandidateModel
    | ((prompt: string) => RawCandidateModel);

  constructor(
    response:
      | RawCandidateModel
      | ((prompt: string) => RawCandidateModel) = {},
  ) {
    this.response = response;
  }

  async generateCandidateModel(prompt: string): Promise<RawCandidateModel> {
    return typeof this.response === 'function'
      ? this.response(prompt)
      : this.response;
  }
}
