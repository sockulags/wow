import { describe, expect, it } from 'vitest';
import { appId } from './index.js';

describe('@wow/desktop', () => {
  it('has an app id', () => {
    expect(appId).toMatch(/^[a-z.]+$/);
  });
});
