import { describe, expect, it } from 'vitest';
import { sidebarGroups } from './index.js';

describe('@wow/web', () => {
  it('lists the sidebar groups with "needs you" first', () => {
    expect(sidebarGroups[0]).toBe('needs_you');
  });
});
