/**
 * Amazon Bedrock LLM client for the Modeling_Engine.
 *
 * Implements {@link LlmClient} against Bedrock's model-agnostic **Converse**
 * API (`@aws-sdk/client-bedrock-runtime`), so it works with the latest Anthropic
 * Claude models (and any other Converse-capable model) without per-model request
 * shaping. It authenticates with the ambient AWS credential chain (env vars,
 * shared config/SSO, or instance role) — no API key is passed in code.
 *
 * The Modeling_Engine prompts it for a strict-JSON *raw candidate model*; the
 * deterministic normalization + constraint-inference pipeline then validates and
 * repairs that output, so the model is never trusted blindly.
 *
 * The Bedrock SDK is imported lazily and the low-level invocation is injectable
 * ({@link BedrockInvoke}), so this file loads without the optional dependency
 * and is unit-testable offline.
 */
import type { LlmClient, RawCandidateModel } from './llmClient.js';
/**
 * The default Bedrock model id. Amazon Nova Pro — a current Amazon-native model
 * that bills directly (no AWS Marketplace subscription required), so it works
 * out of the box. Override via {@link BedrockLlmClientConfig.modelId} (or
 * `AIDA_BEDROCK_MODEL_ID`) to target another model — e.g. the latest Anthropic
 * Claude (`us.anthropic.claude-sonnet-4-20250514-v1:0`) once its Marketplace
 * subscription is active on the account.
 */
export declare const DEFAULT_BEDROCK_MODEL_ID = "us.amazon.nova-pro-v1:0";
/** The low-level Converse invocation, injectable for testing. */
export type BedrockInvoke = (args: {
    modelId: string;
    system: string;
    prompt: string;
    region: string;
    timeoutMs: number;
}) => Promise<string>;
/** Configuration for a {@link BedrockLlmClient}. */
export type BedrockLlmClientConfig = {
    /** Bedrock model id or inference-profile id. Defaults to {@link DEFAULT_BEDROCK_MODEL_ID}. */
    modelId?: string;
    /** AWS region. Defaults to AWS_REGION / AWS_DEFAULT_REGION, then us-east-1. */
    region?: string;
    /** Request timeout in milliseconds. Defaults to 30s (Req 1.1 budget). */
    timeoutMs?: number;
    /** Sampling temperature. Defaults to 0 for the most deterministic output. */
    temperature?: number;
    /** Max tokens to generate. Defaults to 4096 (ample for a JSON data model). */
    maxTokens?: number;
    /** Injectable invocation (defaults to the real Bedrock Converse call). */
    invoke?: BedrockInvoke;
};
/** Raised when the Bedrock call fails or returns no usable text. */
export declare class BedrockRequestError extends Error {
    constructor(message: string);
}
/**
 * An {@link LlmClient} backed by Amazon Bedrock's Converse API.
 */
export declare class BedrockLlmClient implements LlmClient {
    private readonly modelId;
    private readonly region;
    private readonly timeoutMs;
    private readonly invoke;
    constructor(config?: BedrockLlmClientConfig);
    generateCandidateModel(prompt: string): Promise<RawCandidateModel>;
}
