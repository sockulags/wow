import { describe, expect, it } from 'vitest';
import { initialStepRuns } from './index.js';

describe('@wow/workflow-engine', () => {
  it('starts every step as not started', () => {
    const runs = initialStepRuns([
      {
        id: 's1',
        skillName: 'deliver-work',
        providerInstanceId: 'claude-work',
        gateBefore: false,
        gateAfter: true,
        expectedArtifacts: [],
      },
    ]);
    expect(runs).toEqual([{ stepId: 's1', state: 'not_started', artifactsFound: [] }]);
  });
});
