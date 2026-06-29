/**
 * A deterministic, offline "stub" model generator for the Modeling_Engine.
 *
 * This is NOT real inference — real inference is the {@link import('./httpLlmClient.js').HttpLlmClient}.
 * It is a small, dependency-free heuristic so the system runs end to end with
 * no LLM key: given a domain prompt it returns a plausible {@link RawCandidateModel}
 * (which the deterministic normalization + constraint-inference pipeline then
 * turns into a well-formed Data_Model). It recognizes a handful of common demo
 * domains by keyword and otherwise derives entities from capitalized nouns in
 * the prompt, falling back to a single generic entity.
 *
 * Wire it into a {@link StubLlmClient} via `new StubLlmClient(heuristicCandidate)`.
 */
import type { RawCandidateModel } from './llmClient.js';
/**
 * Derive a {@link RawCandidateModel} from a domain prompt using simple,
 * deterministic heuristics. Always returns at least one entity for a non-empty
 * prompt so the offline pipeline produces a usable backend.
 */
export declare function heuristicCandidate(prompt: string): RawCandidateModel;
