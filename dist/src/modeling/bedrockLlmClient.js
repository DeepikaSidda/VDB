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
import { MODELING_SYSTEM_PROMPT, parseCandidateResponse, } from './httpLlmClient.js';
/**
 * The default Bedrock model id. Amazon Nova Pro — a current Amazon-native model
 * that bills directly (no AWS Marketplace subscription required), so it works
 * out of the box. Override via {@link BedrockLlmClientConfig.modelId} (or
 * `AIDA_BEDROCK_MODEL_ID`) to target another model — e.g. the latest Anthropic
 * Claude (`us.anthropic.claude-sonnet-4-20250514-v1:0`) once its Marketplace
 * subscription is active on the account.
 */
export const DEFAULT_BEDROCK_MODEL_ID = 'us.amazon.nova-pro-v1:0';
/** Raised when the Bedrock call fails or returns no usable text. */
export class BedrockRequestError extends Error {
    constructor(message) {
        super(message);
        this.name = 'BedrockRequestError';
    }
}
function defaultRegion() {
    return (process.env.AWS_REGION ??
        process.env.AWS_DEFAULT_REGION ??
        'us-east-1');
}
/**
 * The real Bedrock Converse invocation. Lazily imports the SDK, sends a
 * `ConverseCommand` with a system prompt + single user turn, and returns the
 * concatenated text of the model's reply.
 */
function makeDefaultInvoke(temperature, maxTokens) {
    return async ({ modelId, system, prompt, region, timeoutMs }) => {
        const sdk = (await import('@aws-sdk/client-bedrock-runtime'));
        const client = new sdk.BedrockRuntimeClient({
            region,
            requestHandler: { requestTimeout: timeoutMs },
        });
        const command = new sdk.ConverseCommand({
            modelId,
            system: [{ text: system }],
            messages: [{ role: 'user', content: [{ text: prompt }] }],
            inferenceConfig: { temperature, maxTokens },
        });
        const response = (await client.send(command));
        const blocks = response.output?.message?.content ?? [];
        const text = blocks
            .map((b) => b.text ?? '')
            .join('')
            .trim();
        if (text.length === 0) {
            throw new BedrockRequestError('Bedrock response contained no text output');
        }
        return text;
    };
}
/**
 * An {@link LlmClient} backed by Amazon Bedrock's Converse API.
 */
export class BedrockLlmClient {
    modelId;
    region;
    timeoutMs;
    invoke;
    constructor(config = {}) {
        this.modelId = config.modelId ?? DEFAULT_BEDROCK_MODEL_ID;
        this.region = config.region ?? defaultRegion();
        this.timeoutMs = config.timeoutMs ?? 30_000;
        this.invoke =
            config.invoke ??
                makeDefaultInvoke(config.temperature ?? 0, config.maxTokens ?? 4096);
    }
    async generateCandidateModel(prompt) {
        let text;
        try {
            text = await this.invoke({
                modelId: this.modelId,
                system: MODELING_SYSTEM_PROMPT,
                prompt,
                region: this.region,
                timeoutMs: this.timeoutMs,
            });
        }
        catch (error) {
            if (error instanceof BedrockRequestError) {
                throw error;
            }
            throw new BedrockRequestError(`Bedrock request failed: ${error instanceof Error ? error.message : String(error)}`);
        }
        return parseCandidateResponse(text);
    }
}
//# sourceMappingURL=bedrockLlmClient.js.map