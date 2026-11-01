import { describe, expect, it } from 'vitest';
import { describeRequest } from './index.js';

describe('@wow/server', () => {
  it('compiles against the contracts', () => {
    expect(describeRequest({ id: '1', method: 'settings.get', params: {} })).toBe('settings.get#1');
  });
});
