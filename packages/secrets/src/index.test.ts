import { describe, expect, it } from 'vitest';
import { secretsFileName } from './index.js';

describe('@wow/secrets', () => {
  it('names the secrets file', () => {
    expect(secretsFileName).toBe('secrets.json');
  });
});
