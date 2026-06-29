/**
 * Real LLM client for the Modeling_Engine.
 *
 * Implements {@link LlmClient} against any OpenAI-compatible chat-completions
 * HTTP endpoint (OpenAI, Azure OpenAI, Amazon Bedrock gateways, or a local
 * server). The Modeling_Engine prompts it to emit a *raw candidate model* as
 * strict JSON; deterministic post-processing (`normalizeCandidate` +
 * `inferConstraints`) then validates and repairs that output, so the LLM is
 * never trusted blindly (design principle "Model first, generate second").
 *
 * Uses the built-in `fetch` (Node 18+), so no SDK dependency is required. The
 * endpoint, API key, and model are injected (typically from environment) — see
 * {@link HttpLlmClientConfig}.
 *
 * The response parser {@link parseCandidateResponse} is exported and pure so it
 * can be unit-tested without any network access.
 */
import type { LlmClient, RawCandidateModel } from './llmClient.js';
/** Configuration for an {@link HttpLlmClient}. */
export type HttpLlmClientConfig = {
    /** Chat-completions endpoint, e.g. https://api.openai.com/v1/chat/completions. */
    endpoint: string;
    /** Bearer API key. Sent as `Authorization: Bearer <key>` when present. */
    apiKey?: string;
    /** Model identifier, e.g. `gpt-4o-mini`. */
    model: string;
    /** Sampling temperature. Defaults to 0 for the most deterministic output. */
    temperature?: number;
    /** Request timeout in milliseconds. Defaults to 30s (Req 1.1 budget). */
    timeoutMs?: number;
    /** Injectable fetch (defaults to global fetch); lets tests stub the network. */
    fetchImpl?: typeof fetch;
};
/** Raised when the LLM endpoint cannot be reached or returns a non-OK status. */
export declare class LlmRequestError extends Error {
    constructor(message: string);
}
/** The system prompt instructing the model to emit a strict-JSON data model. */
export declare const MODELING_SYSTEM_PROMPT: string;
/**
 * Parse the LLM message content into a {@link RawCandidateModel}. Tolerant of
 * markdown code fences and surrounding prose: it extracts the first balanced
 * JSON object. Returns an empty candidate (`{}`) when nothing parseable is
 * found — the Modeling_Engine then fails closed with NO_DATA_MODEL. The result
 * is intentionally loose (a RawCandidateModel); structural validation happens
 * downstream.
 */
export declare function parseCandidateResponse(content: string): RawCandidateModel;
/**
 * An {@link LlmClient} that calls an OpenAI-compatible chat-completions
 * endpoint and parses the response into a {@link RawCandidateModel}.
 */
export declare class HttpLlmClient implements LlmClient {
    private readonly config;
    constructor(config: HttpLlmClientConfig);
    generateCandidateModel(prompt: string): Promise<RawCandidateModel>;
    private headers;
}
