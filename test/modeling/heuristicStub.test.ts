/**
 * Tests for the offline heuristic stub model generator
 * (src/modeling/heuristicStub.ts).
 *
 * Verifies the heuristic produces a usable, well-formed model for known demo
 * domains, derives entities from capitalized nouns otherwise, and always yields
 * at least one entity so the offline pipeline can complete. Each produced
 * candidate is run through the real Modeling_Engine to confirm it normalizes to
 * a valid Data_Model.
 */

import { describe, it, expect } from 'vitest';
import { heuristicCandidate } from '../../src/modeling/heuristicStub.js';
import { ModelingEngine } from '../../src/modeling/modelingEngine.js';
import { StubLlmClient } from '../../src/modeling/llmClient.js';
import { validateDataModel } from '../../src/model/invariants.js';
import { isOk, unwrap } from '../../src/model/result.js';

async function modelFor(prompt: string) {
  const engine = new ModelingEngine(new StubLlmClient(heuristicCandidate));
  const result = await engine.inferFromPrompt(prompt);
  expect(isOk(result)).toBe(true);
  return unwrap(result);
}

describe('heuristicCandidate', () => {
  it('recognizes the hotel-booking domain', async () => {
    const model = await modelFor('Build a hotel booking system');
    const names = model.entities.map((e) => e.name);
    expect(names).toEqual(expect.arrayContaining(['Hotel', 'Room', 'Guest', 'Booking']));
    expect(isOk(validateDataModel(model))).toBe(true);
  });

  it('recognizes the library domain', async () => {
    const model = await modelFor('a library that lets members borrow books');
    expect(model.entities.map((e) => e.name)).toEqual(
      expect.arrayContaining(['Book', 'Member', 'Loan']),
    );
  });

  it('derives entities from capitalized nouns for an unknown domain', () => {
    const candidate = heuristicCandidate('Track Vehicle and Driver assignments');
    const names = (candidate.entities ?? []).map((e) => e.name);
    expect(names).toEqual(expect.arrayContaining(['Vehicle', 'Driver']));
  });

  it('falls back to a single generic entity when nothing is recognizable', async () => {
    const model = await modelFor('make something for me');
    expect(model.entities.length).toBeGreaterThanOrEqual(1);
    expect(isOk(validateDataModel(model))).toBe(true);
  });
});
