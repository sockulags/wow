import { describe, expect, it } from 'vitest';
import { encodeRequest } from './index.js';

describe('@wow/client-runtime', () => {
  it('encodes a valid request', () => {
    expect(JSON.parse(encodeRequest({ id: '7', method: 'ping', params: null }))).toEqual({
      id: '7',
      method: 'ping',
      params: null,
    });
  });
});
