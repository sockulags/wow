import { describe, expect, it } from 'vitest';
import { providerKind } from './index.js';

describe('@wow/provider-codex', () => {
  it('is the codex provider', () => {
    expect(providerKind).toBe('codex');
  });
});
