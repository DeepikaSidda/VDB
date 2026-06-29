/**
 * Tests for the real HTTP LLM client (src/modeling/httpLlmClient.ts).
 *
 * The network is stubbed via an injected `fetchImpl`, so these run fully
 * offline. They cover the pure response parser (tolerant JSON extraction) and
 * the client's request/response handling, including error paths. They also
 * verify the parsed candidate flows correctly through the real Modeling_Engine
 * (normalization + constraint inference) into a well-formed Data_Model.
 */

import { describe, it, expect } from 'vitest';
import {
  HttpLlmClient,
  LlmRequestError,
  parseCandidateResponse,
} from '../../src/modeling/httpLlmClient.js';
import { ModelingEngine } from '../../src/modeling/modelingEngine.js';
import { validateDataModel } from '../../src/model/invariants.js';
import { isOk, unwrap } from '../../src/model/result.js';

describe('parseCandidateResponse', () => {
  it('parses a clean JSON object', () => {
    const candidate = parseCandidateResponse(
      JSON.stringify({
        entities: [
          { name: 'User', primaryKey: ['id'], attributes: [{ name: 'email', dataType: 'TEXT', unique: true, required: true }] },
        ],
        relationships: [],
      }),
    );
    expect(candidate.entities).toHaveLength(1);
    expect(candidate.entities?.[0].name).toBe('User');
    expect(candidate.entities?.[0].attributes?.[0]).toEqual({
      name: 'email',
      dataType: 'TEXT',
      unique: true,
      required: true,
    });
  });

  it('extracts JSON from markdown fences and surrounding prose', () => {
    const content =
      'Here is the model:\n```json\n{ "entities": [ { "name": "Post" } ] }\n```\nDone.';
    const candidate = parseCandidateResponse(content);
    expect(candidate.entities?.[0].name).toBe('Post');
  });

  it('returns an empty candidate for non-JSON content', () => {
    expect(parseCandidateResponse('no json here')).toEqual({});
  });

  it('coerces malformed fields rather than throwing', () => {
    const candidate = parseCandidateResponse(
      JSON.stringify({ entities: [{ name: 123, attributes: 'nope' }], relationships: 'no' }),
    );
    // name 123 is not a string -> undefined; attributes 'nope' -> [].
    expect(candidate.entities?.[0].name).toBeUndefined();
    expect(candidate.entities?.[0].attributes).toEqual([]);
    expect(candidate.relationships).toEqual([]);
  });
});

/** A fetch stub returning an OpenAI-compatible chat-completions response. */
function fetchReturning(content: string, ok = true, status = 200): typeof fetch {
  return (async () =>
    ({
      ok,
      status,
      statusText: ok ? 'OK' : 'Error',
      json: async () => ({ choices: [{ message: { content } }] }),
    }) as unknown as Response) as unknown as typeof fetch;
}

describe('HttpLlmClient', () => {
  const config = {
    endpoint: 'https://api.example.com/v1/chat/completions',
    apiKey: 'sk-test',
    model: 'gpt-4o-mini',
  };

  it('returns a parsed raw candidate model on a successful response', async () => {
    const client = new HttpLlmClient({
      ...config,
      fetchImpl: fetchReturning(
        JSON.stringify({ entities: [{ name: 'Book', attributes: [{ name: 'title', dataType: 'TEXT' }] }] }),
      ),
    });
    const candidate = await client.generateCandidateModel('a library');
    expect(candidate.entities?.[0].name).toBe('Book');
  });

  it('throws LlmRequestError on a non-OK HTTP status', async () => {
    const client = new HttpLlmClient({
      ...config,
      fetchImpl: fetchReturning('', false, 503),
    });
    await expect(client.generateCandidateModel('x')).rejects.toBeInstanceOf(
      LlmRequestError,
    );
  });

  it('throws LlmRequestError when the network call rejects', async () => {
    const failing = (async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;
    const client = new HttpLlmClient({ ...config, fetchImpl: failing });
    await expect(client.generateCandidateModel('x')).rejects.toBeInstanceOf(
      LlmRequestError,
    );
  });

  it('feeds a real Modeling_Engine to a well-formed Data_Model', async () => {
    const client = new HttpLlmClient({
      ...config,
      fetchImpl: fetchReturning(
        JSON.stringify({
          entities: [
            { name: 'Author', attributes: [{ name: 'email', dataType: 'TEXT', unique: true, required: true }] },
            { name: 'Book', attributes: [{ name: 'title', dataType: 'TEXT', required: true }] },
          ],
          relationships: [{ source: 'Book', target: 'Author', cardinality: 'ONE_TO_MANY' }],
        }),
      ),
    });
    const engine = new ModelingEngine(client);
    const result = await engine.inferFromPrompt('a bookstore');
    expect(isOk(result)).toBe(true);
    const model = unwrap(result);
    expect(isOk(validateDataModel(model))).toBe(true);
    expect(model.entities.map((e) => e.name).sort()).toEqual(['Author', 'Book']);
  });
});
