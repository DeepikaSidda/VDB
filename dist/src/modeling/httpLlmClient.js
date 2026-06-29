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
/** Raised when the LLM endpoint cannot be reached or returns a non-OK status. */
export class LlmRequestError extends Error {
    constructor(message) {
        super(message);
        this.name = 'LlmRequestError';
    }
}
/** The system prompt instructing the model to emit a strict-JSON data model. */
export const MODELING_SYSTEM_PROMPT = [
    'You are a senior relational database architect.',
    'Given a natural-language description of an application domain, infer a clean,',
    'normalized relational data model.',
    '',
    'Respond with STRICT JSON ONLY (no prose, no markdown fences) of the shape:',
    '{',
    '  "entities": [',
    '    {',
    '      "name": "EntityName",',
    '      "primaryKey": ["id"],',
    '      "attributes": [',
    '        { "name": "fieldName", "dataType": "UUID|TEXT|VARCHAR|INTEGER|BIGINT|NUMERIC|BOOLEAN|DATE|TIMESTAMP|JSON", "unique": false, "required": true }',
    '      ]',
    '    }',
    '  ],',
    '  "relationships": [',
    '    { "source": "EntityA", "target": "EntityB", "cardinality": "ONE_TO_ONE|ONE_TO_MANY|MANY_TO_MANY" }',
    '  ]',
    '}',
    '',
    'Rules: prefer a surrogate "id" primary key per entity; mark identifying',
    'fields unique; mark mandatory fields required; use MANY_TO_MANY where natural.',
].join('\n');
/**
 * Parse the LLM message content into a {@link RawCandidateModel}. Tolerant of
 * markdown code fences and surrounding prose: it extracts the first balanced
 * JSON object. Returns an empty candidate (`{}`) when nothing parseable is
 * found — the Modeling_Engine then fails closed with NO_DATA_MODEL. The result
 * is intentionally loose (a RawCandidateModel); structural validation happens
 * downstream.
 */
export function parseCandidateResponse(content) {
    const json = extractJsonObject(content);
    if (json === null) {
        return {};
    }
    let parsed;
    try {
        parsed = JSON.parse(json);
    }
    catch {
        return {};
    }
    if (typeof parsed !== 'object' || parsed === null) {
        return {};
    }
    const obj = parsed;
    return {
        entities: coerceEntities(obj.entities),
        relationships: coerceRelationships(obj.relationships),
    };
}
/** Extract the first balanced `{...}` object from arbitrary text. */
function extractJsonObject(text) {
    const start = text.indexOf('{');
    if (start === -1) {
        return null;
    }
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < text.length; i++) {
        const ch = text[i];
        if (inString) {
            if (escaped) {
                escaped = false;
            }
            else if (ch === '\\') {
                escaped = true;
            }
            else if (ch === '"') {
                inString = false;
            }
            continue;
        }
        if (ch === '"') {
            inString = true;
        }
        else if (ch === '{') {
            depth += 1;
        }
        else if (ch === '}') {
            depth -= 1;
            if (depth === 0) {
                return text.slice(start, i + 1);
            }
        }
    }
    return null;
}
function asArray(value) {
    return Array.isArray(value) ? value : [];
}
function asString(value) {
    return typeof value === 'string' ? value : undefined;
}
function coerceEntities(value) {
    return asArray(value).map((raw) => {
        const e = (raw ?? {});
        return {
            name: asString(e.name),
            primaryKey: Array.isArray(e.primaryKey)
                ? e.primaryKey.filter((p) => typeof p === 'string')
                : undefined,
            attributes: coerceAttributes(e.attributes),
        };
    });
}
function coerceAttributes(value) {
    return asArray(value).map((raw) => {
        const a = (raw ?? {});
        return {
            name: asString(a.name),
            dataType: asString(a.dataType),
            unique: typeof a.unique === 'boolean' ? a.unique : undefined,
            required: typeof a.required === 'boolean' ? a.required : undefined,
        };
    });
}
function coerceRelationships(value) {
    return asArray(value).map((raw) => {
        const r = (raw ?? {});
        return {
            source: asString(r.source),
            target: asString(r.target),
            cardinality: asString(r.cardinality),
        };
    });
}
/**
 * An {@link LlmClient} that calls an OpenAI-compatible chat-completions
 * endpoint and parses the response into a {@link RawCandidateModel}.
 */
export class HttpLlmClient {
    config;
    constructor(config) {
        this.config = {
            endpoint: config.endpoint,
            apiKey: config.apiKey,
            model: config.model,
            temperature: config.temperature ?? 0,
            timeoutMs: config.timeoutMs ?? 30_000,
            fetchImpl: config.fetchImpl ?? fetch,
        };
    }
    async generateCandidateModel(prompt) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this.config.timeoutMs);
        let response;
        try {
            response = await this.config.fetchImpl(this.config.endpoint, {
                method: 'POST',
                headers: this.headers(),
                body: JSON.stringify({
                    model: this.config.model,
                    temperature: this.config.temperature,
                    messages: [
                        { role: 'system', content: MODELING_SYSTEM_PROMPT },
                        { role: 'user', content: prompt },
                    ],
                    response_format: { type: 'json_object' },
                }),
                signal: controller.signal,
            });
        }
        catch (error) {
            throw new LlmRequestError(`LLM request failed: ${error instanceof Error ? error.message : String(error)}`);
        }
        finally {
            clearTimeout(timer);
        }
        if (!response.ok) {
            throw new LlmRequestError(`LLM endpoint returned HTTP ${response.status} ${response.statusText}`);
        }
        const body = (await response.json());
        const content = body.choices?.[0]?.message?.content;
        if (typeof content !== 'string') {
            throw new LlmRequestError('LLM response did not contain message content');
        }
        return parseCandidateResponse(content);
    }
    headers() {
        const headers = {
            'content-type': 'application/json',
        };
        if (this.config.apiKey) {
            headers.authorization = `Bearer ${this.config.apiKey}`;
        }
        return headers;
    }
}
//# sourceMappingURL=httpLlmClient.js.map