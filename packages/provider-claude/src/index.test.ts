import { describe, expect, it } from 'vitest';
import { providerKind } from './index.js';

describe('@wow/provider-claude', () => {
  it('is the claude provider', () => {
    expect(providerKind).toBe('claude');
  });
});
