import { ProviderModel } from '@wow/contracts';
import { describe, expect, it } from 'vitest';
import { MockProviderAdapter, mockCodexModels } from './providers.js';

// Agent workbench U1: the mock answers listModels the way Codex does, and the fields survive the
// parse the provider service does before `provider.listModels` answers.
describe('the mock provider lists models like Codex', () => {
  it('answers with descriptions, a default, default efforts and image input', async () => {
    const adapter = new MockProviderAdapter('codex', undefined, undefined, () => mockCodexModels);
    const models = ProviderModel.array().parse(await adapter.send({ type: 'listModels' }));
    expect(models).toEqual(mockCodexModels);
    expect(models.every((model) => model.description !== '')).toBe(true);
    expect(models.filter((model) => model.isDefault)).toHaveLength(1);
    expect(models.every((model) => model.defaultEffort !== undefined)).toBe(true);
    expect(models.map((model) => model.imageInput)).toEqual([true, false]);
  });
});
