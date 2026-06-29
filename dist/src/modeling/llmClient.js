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
export class StubLlmClient {
    response;
    constructor(response = {}) {
        this.response = response;
    }
    async generateCandidateModel(prompt) {
        return typeof this.response === 'function'
            ? this.response(prompt)
            : this.response;
    }
}
//# sourceMappingURL=llmClient.js.map