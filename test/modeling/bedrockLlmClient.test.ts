/**
 * Offline tests for the Amazon Bedrock LLM client
 * (src/modeling/bedrockLlmClient.ts).
 *
 * The Bedrock Converse call is stubbed via the injectable `invoke`, so these
 * run with no AWS access. They verify the system prompt + prompt are passed
 * through, the model id/region default correctly, the response is parsed into a
 * raw candidate model (and flows through the real Modeling_Engine to a valid
 * Data_Model), and failures surface as BedrockRequestError.
 */

import { describe, it, expect } from 'vitest';
import {
  BedrockLlmClient,
  BedrockRequestError,
  DEFAULT_BEDROCK_MODEL_ID,
  type BedrockInvoke,
} from '../../src/modeling/bedrockLlmClient.js';
import { MODELING_SYSTEM_PROMPT } from '../../src/modeling/httpLlmClient.js';
import { ModelingEngine } from '../../src/modeling/modelingEngine.js';
import { validateDataModel } from '../../src/model/invariants.js';
import { isOk, unwrap } from '../../src/model/result.js';

describe('BedrockLlmClient', () => {
  it('invokes Converse with the system prompt and user prompt, parses the JSON reply', async () => {
    const seen: { modelId: string; system: string; prompt: string; region: string } =
      { modelId: '', system: '', prompt: '', region: '' };
    const invoke: BedrockInvoke = async (args) => {
      seen.modelId = args.modelId;
      seen.system = args.system;
      seen.prompt = args.prompt;
      seen.region = args.region;
      return JSON.stringify({
        entities: [{ name: 'Patient', attributes: [{ name: 'name', dataType: 'TEXT', required: true }] }],
        relationships: [],
      });
    };

    const client = new BedrockLlmClient({ region: 'us-west-2', invoke });
    const candidate = await client.generateCandidateModel('a clinic');

    expect(seen.modelId).toBe(DEFAULT_BEDROCK_MODEL_ID);
    expect(seen.region).toBe('us-west-2');
    expect(seen.system).toBe(MODELING_SYSTEM_PROMPT);
    expect(seen.prompt).toBe('a clinic');
    expect(candidate.entities?.[0].name).toBe('Patient');
  });

  it('honors a custom model id', async () => {
    let usedModel = '';
    const invoke: BedrockInvoke = async (args) => {
      usedModel = args.modelId;
      return '{ "entities": [ { "name": "X" } ] }';
    };
    const client = new BedrockLlmClient({
      modelId: 'anthropic.claude-3-5-sonnet-20241022-v2:0',
      invoke,
    });
    await client.generateCandidateModel('x');
    expect(usedModel).toBe('anthropic.claude-3-5-sonnet-20241022-v2:0');
  });

  it('wraps invocation failures in BedrockRequestError', async () => {
    const invoke: BedrockInvoke = async () => {
      throw new Error('AccessDeniedException');
    };
    const client = new BedrockLlmClient({ invoke });
    await expect(client.generateCandidateModel('x')).rejects.toBeInstanceOf(
      BedrockRequestError,
    );
  });

  it('feeds a real Modeling_Engine to a well-formed Data_Model', async () => {
    const invoke: BedrockInvoke = async () =>
      JSON.stringify({
        entities: [
          { name: 'Doctor', attributes: [{ name: 'name', dataType: 'TEXT', required: true }] },
          { name: 'Appointment', attributes: [{ name: 'scheduledAt', dataType: 'TIMESTAMP', required: true }] },
        ],
        relationships: [{ source: 'Appointment', target: 'Doctor', cardinality: 'ONE_TO_MANY' }],
      });
    const engine = new ModelingEngine(new BedrockLlmClient({ invoke }));
    const result = await engine.inferFromPrompt('a clinic scheduling system');
    expect(isOk(result)).toBe(true);
    const model = unwrap(result);
    expect(isOk(validateDataModel(model))).toBe(true);
    expect(model.entities.map((e) => e.name).sort()).toEqual(['Appointment', 'Doctor']);
  });
});
