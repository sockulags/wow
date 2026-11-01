import { describe, expect, it } from 'vitest';
import { err, ok } from './index.js';

describe('@wow/shared', () => {
  it('builds results', () => {
    expect(ok(1)).toEqual({ ok: true, value: 1 });
    expect(err('nope')).toEqual({ ok: false, error: 'nope' });
  });
});
