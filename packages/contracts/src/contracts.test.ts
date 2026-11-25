import { describe, expect, it } from 'vitest';
import {
  AssistantChange,
  AssistantChangeRecord,
  AssistantProposal,
  AssistantProposalRecord,
  DomainEvent,
  defaultSecretPatterns,
  hiddenText,
  hideSecrets,
  hideSecretsDeep,
  looksLikeSecret,
  secretPatterns,
  settingGroupTitles,
  SettingGroup,
  Command,
  WorkingCopy,
  workingCopyOnDisk,
  subscriptionTopics,
  Keybinding,
  KeyValueList,
  ProviderCommand,
  SettingScopeRef,
  SubscribeParams,
  rpcMethods,
  ProviderEvent,
  RpcResponse,
  ServerMessage,
  ruleConditionText,
  ruleProblems,
  WorkflowStep,
  settingsRegistry,
  type SettingDefinition,
} from './index.js';

describe('rpc envelope', () => {
  it('accepts a result or an error but not both', () => {
    expect(RpcResponse.safeParse({ id: '1', result: { ok: true } }).success).toBe(true);
    expect(
      RpcResponse.safeParse({ id: '1', error: { code: 'invalid', message: 'x' } }).success,
    ).toBe(true);
    expect(
      RpcResponse.safeParse({ id: '1', result: 1, error: { code: 'x', message: 'y' } }).success,
    ).toBe(false);
  });

  it('accepts subscription pushes from the server', () => {
    expect(ServerMessage.safeParse({ subscription: 'threads', data: [] }).success).toBe(true);
  });
});

describe('provider protocol', () => {
  it('parses a start turn command', () => {
    const command = ProviderCommand.parse({
      type: 'startTurn',
      threadId: 't1',
      cwd: 'C:\\work\\wow',
      prompt: 'hello',
      model: 'opus',
      effort: 'high',
      permissionMode: 'default',
    });
    expect(command.type).toBe('startTurn');
  });

  it('rejects an unknown event type', () => {
    expect(ProviderEvent.safeParse({ type: 'nope', threadId: 't1' }).success).toBe(false);
  });

  it('parses a question with options', () => {
    const event = ProviderEvent.parse({
      type: 'questionAsked',
      threadId: 't1',
      questionId: 'q1',
      question: 'Which database?',
      options: [{ label: 'SQLite' }, { label: 'Postgres', description: 'needs a server' }],
      multiSelect: false,
    });
    expect(event.type).toBe('questionAsked');
  });
});

describe('workflow contracts', () => {
  it('parses a step', () => {
    expect(
      WorkflowStep.parse({
        id: 's1',
        skillName: 'capture-intent',
        providerInstanceId: 'claude-work',
        gateBefore: false,
        gateAfter: true,
        expectedArtifacts: ['intents/*/intent.md'],
      }).gateAfter,
    ).toBe(true);
  });
});

describe('settings registry', () => {
  const entries: [string, SettingDefinition][] = Object.entries(settingsRegistry);

  it('fills in every settings group', () => {
    const groups = new Set(entries.map(([, definition]) => definition.group));
    expect(groups).toEqual(
      new Set([
        'providers',
        'chat',
        'approvals',
        'calendar',
        'outlook',
        'scheduler',
        'workflows',
        'skills',
        'trackers',
        'hosts',
        'viewer',
        'diff',
        'workspaces',
        'assistant',
        'appearance',
        'keybindings',
        'desktop',
        'updates',
        'advanced',
      ]),
    );
  });

  it('accepts the answers of files.read and nothing between them', () => {
    const result = rpcMethods['files.read'].result;
    const read = { absolutePath: '/work/demo/a.md', size: 3 };
    expect(result.safeParse({ kind: 'markdown', ...read, text: '# a' }).success).toBe(true);
    expect(
      result.safeParse({ kind: 'image', ...read, mediaType: 'image/png', base64: 'AAEC' }).success,
    ).toBe(true);
    expect(
      result.safeParse({ kind: 'refused', reason: 'outside', message: 'Not read.' }).success,
    ).toBe(true);
    expect(result.safeParse({ kind: 'image', ...read, text: 'not a picture' }).success).toBe(false);
    expect(
      result.safeParse({ kind: 'image', ...read, mediaType: 'text/html', base64: '' }).success,
    ).toBe(false);
    expect(result.safeParse({ kind: 'refused', reason: 'secret', message: 'x' }).success).toBe(
      false,
    );
    const params = rpcMethods['files.read'].params;
    expect(params.safeParse({ threadId: 't1', path: 'a.md' }).success).toBe(true);
    expect(params.safeParse({ threadId: 't1', path: '' }).success).toBe(false);
    expect(params.safeParse({ threadId: 't1', path: 'a\0.md' }).success).toBe(false);
  });

  it('accepts shortcuts with modifiers or empty, and marks the schema as a keybinding', () => {
    expect(Keybinding.safeParse('Mod+K').success).toBe(true);
    expect(Keybinding.safeParse('Mod+Shift+,').success).toBe(true);
    expect(Keybinding.safeParse('').success).toBe(true);
    expect(Keybinding.safeParse('Mod+').success).toBe(false);
    expect(Keybinding.safeParse('Hyper+K').success).toBe(false);
    expect(Keybinding.meta()?.['widget']).toBe('keybinding');
  });

  it('rejects duplicate keys in a key-value list', () => {
    const entry = { key: 'TOKEN', value: 'x', secret: true };
    expect(KeyValueList.safeParse([entry]).success).toBe(true);
    expect(KeyValueList.safeParse([entry, entry]).success).toBe(false);
  });

  it.each(entries)('%s has a default that passes its own schema', (_key, definition) => {
    expect(definition.schema.safeParse(definition.default).success).toBe(true);
  });

  it('prefixes every key with its group', () => {
    for (const [key, definition] of entries) {
      expect(key.startsWith(`${definition.group}.`)).toBe(true);
    }
  });

  it('rejects an unknown time zone and inverted work hours', () => {
    expect(settingsRegistry['calendar.zone'].schema.safeParse('Europe/Stockholm').success).toBe(
      true,
    );
    expect(settingsRegistry['calendar.zone'].schema.safeParse('Mars/Olympus').success).toBe(false);
    expect(
      settingsRegistry['calendar.workHours'].schema.safeParse({
        start: '17:00',
        end: '08:00',
        days: ['monday'],
      }).success,
    ).toBe(false);
  });
});

describe('server contracts', () => {
  it('accepts only the three setting scopes', () => {
    expect(SettingScopeRef.safeParse('global').success).toBe(true);
    expect(SettingScopeRef.safeParse('project:p1').success).toBe(true);
    expect(SettingScopeRef.safeParse('provider:claude-work').success).toBe(true);
    expect(SettingScopeRef.safeParse('project:').success).toBe(false);
    expect(SettingScopeRef.safeParse('team:x').success).toBe(false);
  });

  it('needs a threadId for thread-scoped topics', () => {
    expect(SubscribeParams.safeParse({ topic: 'projects' }).success).toBe(true);
    expect(SubscribeParams.safeParse({ topic: 'threadItems' }).success).toBe(false);
    expect(SubscribeParams.safeParse({ topic: 'threadItems', threadId: 't1' }).success).toBe(true);
  });

  it('dispatches only known commands', () => {
    const params = rpcMethods.dispatch.params;
    expect(
      params.safeParse({
        commandId: 'c1',
        command: { type: 'setting.set', key: 'k', scope: 'global', value: 1 },
      }).success,
    ).toBe(true);
    expect(Command.safeParse({ type: 'project.explode', projectId: 'p1' }).success).toBe(false);
  });
});

describe('working copies', () => {
  const copy = {
    path: '/home/me/.wow/workspaces/tea-timer-1a2b3c4d',
    state: 'pending',
    startSha: null,
    defaultBranch: null,
    note: null,
    unpushed: null,
    error: null,
  };

  it('accepts a working copy in every state and only those', () => {
    for (const state of ['pending', 'ready', 'failed', 'kept', 'removed']) {
      expect(WorkingCopy.safeParse({ ...copy, state }).success).toBe(true);
    }
    expect(WorkingCopy.safeParse({ ...copy, state: 'gone' }).success).toBe(false);
    expect(WorkingCopy.safeParse({ ...copy, path: '' }).success).toBe(false);
    expect(workingCopyOnDisk(WorkingCopy.parse({ ...copy, state: 'kept' }))).toBe(true);
    expect(workingCopyOnDisk(WorkingCopy.parse({ ...copy, state: 'removed' }))).toBe(false);
  });
});

const reviewStep = {
  id: 'review',
  skillName: 'check-work',
  providerInstanceId: 'claude-work',
  gateBefore: false,
  gateAfter: false,
  expectedArtifacts: [],
};
const toBuild = { type: 'step' as const, stepId: 'build' };
const withRule = (when: unknown) =>
  WorkflowStep.safeParse({ ...reviewStep, rules: [{ when, goTo: toBuild }] });

describe('rules on a step (workflow branches spec 1 to 18)', () => {
  it('takes a step with rules and still takes one without', () => {
    expect(WorkflowStep.safeParse(reviewStep).success).toBe(true);
    const rules = [
      { when: { fact: 'verdict', is: 'changesRequested' }, goTo: toBuild },
      { when: { fact: 'checks', is: 'failed' }, goTo: toBuild },
      { when: { fact: 'artifacts', is: 'missing' }, goTo: { type: 'end' } },
      { when: { fact: 'stepFailed' }, goTo: { type: 'end' } },
    ];
    expect(WorkflowStep.safeParse({ ...reviewStep, rules }).success).toBe(true);
  });

  it('refuses a fact or value wow does not read', () => {
    expect(withRule({ fact: 'changeSize', is: 'large' }).success).toBe(false);
    expect(withRule({ fact: 'verdict', is: 'maybe' }).success).toBe(false);
    expect(withRule({ fact: 'checks', is: 'undecided' }).success).toBe(false);
  });

  it('names what is wrong with rules: a missing step, no expected artifacts, one condition twice', () => {
    const step = WorkflowStep.parse({
      ...reviewStep,
      rules: [
        {
          when: { fact: 'verdict', is: 'changesRequested' },
          goTo: { type: 'step', stepId: 'gone' },
        },
        { when: { fact: 'artifacts', is: 'missing' }, goTo: { type: 'end' } },
        { when: { fact: 'verdict', is: 'changesRequested' }, goTo: { type: 'end' } },
      ],
    });
    expect(ruleProblems([step])).toEqual([
      {
        stepId: 'review',
        rule: 0,
        reason: 'The rule "verdict changes requested" goes to a step that no longer exists',
      },
      {
        stepId: 'review',
        rule: 1,
        reason: 'The rule "artifacts missing" needs expected artifacts, and this step names none',
      },
      {
        stepId: 'review',
        rule: 2,
        reason: 'The step already has a rule for "verdict changes requested"',
      },
    ]);
    expect(ruleProblems([WorkflowStep.parse(reviewStep)])).toEqual([]);
  });

  it('says a condition in words', () => {
    expect(ruleConditionText({ fact: 'verdict', is: 'none' })).toBe('no verdict');
    expect(ruleConditionText({ fact: 'checks', is: 'successful' })).toBe('checks successful');
    expect(ruleConditionText({ fact: 'stepFailed' })).toBe('step failed');
  });
});

describe('app assistant', () => {
  const at = '2026-11-10T08:00:00.000Z';
  const place = { label: 'Settings → Calendar', path: '/settings/calendar' };
  const change = {
    id: 'c1',
    at,
    commandType: 'setting.set',
    what: 'Work hours',
    from: '08:00–17:00',
    to: '08:00–16:00',
    place,
    target: { kind: 'setting', id: 'calendar.workHours:global' },
    state: 'applied',
    undoneAt: null,
  };
  // What the server keeps beside the row.
  const changeRecord = {
    ...change,
    expect: { value: { start: '08:00', end: '16:00' } },
    inverse: [{ type: 'setting.reset', key: 'calendar.workHours', scope: 'global' }],
  };
  const proposal = {
    id: 'p1',
    at,
    commandType: 'project.delete',
    title: 'Remove Tea',
    lines: [{ what: 'Project', from: 'Tea', to: null }],
    place: { label: 'Settings → Projects', path: '/settings/projects' },
    state: 'pending',
    answeredAt: null,
    reason: null,
  };
  const proposalRecord = {
    ...proposal,
    command: { type: 'project.delete', projectId: 'tea' },
    basis: { project: 'Tea' },
  };

  it('has commands for the answers only the user gives', () => {
    expect(Command.safeParse({ type: 'assistant.undo', changeId: 'c1' }).success).toBe(true);
    expect(Command.safeParse({ type: 'assistant.proposal.accept', proposalId: 'p1' }).success).toBe(
      true,
    );
    expect(
      Command.safeParse({ type: 'assistant.proposal.decline', proposalId: 'p1', reason: 'No' })
        .success,
    ).toBe(true);
    expect(
      Command.safeParse({ type: 'assistant.proposal.decline', proposalId: 'p1' }).success,
    ).toBe(true);
    expect(Command.safeParse({ type: 'assistant.undo' }).success).toBe(false);
    // A command carries no origin: who sent it is the connection's to say, not the sender's.
    expect(Command.parse({ type: 'assistant.undo', changeId: 'c1', origin: 'user' })).toEqual({
      type: 'assistant.undo',
      changeId: 'c1',
    });
  });

  it('describes a change and a proposal, as rows of their own topics and as events', () => {
    expect(subscriptionTopics.assistantChanges.row.parse(change)).toEqual(change);
    expect(subscriptionTopics.assistantProposals.row.parse(proposal)).toEqual(proposal);
    expect(AssistantChange.safeParse({ ...change, state: 'gone' }).success).toBe(false);
    expect(AssistantChange.safeParse({ ...change, from: null }).success).toBe(true);
    // The topics' rows leave the server's own record behind: what Undo puts back and the held
    // command hold real values.
    expect(subscriptionTopics.assistantChanges.row.parse(changeRecord)).toEqual(change);
    expect(subscriptionTopics.assistantProposals.row.parse(proposalRecord)).toEqual(proposal);
    expect(AssistantChangeRecord.safeParse({ ...changeRecord, expect: null }).success).toBe(true);
    // An inverse or a held command that is not a command is not stored.
    expect(
      AssistantChangeRecord.safeParse({ ...changeRecord, inverse: [{ type: 'project.explode' }] })
        .success,
    ).toBe(false);
    expect(
      AssistantProposalRecord.safeParse({ ...proposalRecord, command: { type: 'nothing' } })
        .success,
    ).toBe(false);
    expect(AssistantProposal.safeParse({ ...proposal, state: 'applied' }).success).toBe(false);
    for (const event of [
      { kind: 'assistant.changed', aggregate: 'c1', payload: changeRecord },
      { kind: 'assistant.changeUndone', aggregate: 'c1', payload: { changeId: 'c1', at } },
      { kind: 'assistant.proposed', aggregate: 'p1', payload: proposalRecord },
      {
        kind: 'assistant.proposalAnswered',
        aggregate: 'p1',
        payload: { proposalId: 'p1', state: 'declined', reason: 'Not today', at },
      },
    ]) {
      expect(DomainEvent.safeParse(event).success).toBe(true);
    }
    expect(
      DomainEvent.safeParse({
        kind: 'assistant.proposalAnswered',
        aggregate: 'p1',
        payload: { proposalId: 'p1', state: 'pending', reason: null, at },
      }).success,
    ).toBe(false);
  });

  it('registers the assistant settings and names every settings page', () => {
    expect(settingsRegistry['assistant.secretPatterns'].default).toEqual(defaultSecretPatterns);
    expect(Object.keys(settingGroupTitles)).toEqual(SettingGroup.options);
    expect(settingGroupTitles.assistant).toBe('Assistant');
  });

  it('refuses a pattern that does not compile or that matches nothing at all', () => {
    const { schema } = settingsRegistry['assistant.secretPatterns'];
    expect(schema.safeParse(['tea-[0-9]{4}']).success).toBe(true);
    expect(schema.safeParse(['(']).success).toBe(false);
    expect(schema.safeParse(['x*']).success).toBe(false);
    expect(schema.safeParse(['']).success).toBe(false);
    expect(schema.safeParse([]).success).toBe(true);
  });

  it('hides known token shapes, key blocks and a long random string after "token", "password" or "key"', () => {
    const patterns = secretPatterns(defaultSecretPatterns);
    const secrets = [
      'ghp_abcdefghijklmnopqrstuvwxyz012345',
      'github_pat_11ABCDEFG0abcdefghijkl_mnopqrstuvwxyz',
      'glpat-abcdefghijklmnopqrst',
      'ATATT3xFfGF0abcdefghijklmnop',
      'xoxb-1234567890-abcdefghij',
      'sk-abcdefghijklmnopqrstuvwx',
      'AKIAABCDEFGHIJKLMNOP',
    ];
    for (const secret of secrets) {
      expect(hideSecrets(`use ${secret} for it`, patterns)).toBe(`use ${hiddenText} for it`);
      expect(looksLikeSecret(secret, patterns)).toBe(true);
    }
    expect(
      hideSecrets(
        'before -----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY----- after',
        patterns,
      ),
    ).toBe(`before ${hiddenText} after`);
    expect(hideSecrets('my password is 9f8e7d6c5b4a39281706f5e4d3c2', patterns)).toBe(
      `my password is ${hiddenText}`,
    );
    expect(hideSecrets('password: 9f8e7d6c5b4a39281706f5e4d3c2', patterns)).toBe(
      `password: ${hiddenText}`,
    );
    expect(hideSecrets('token=Zm9vYmFyYmF6cXV4MTIzNDU2Nzg5MA==', patterns)).toBe(
      `token=${hiddenText}`,
    );
    for (const harmless of [
      'Set the work hours to 08:00–16:00',
      'the key keybindings.goCalendar opens the calendar',
      'key: a-long-name-without-any-digit-in-it',
      'https://gitlab.example/tea/pot',
      'the branch task-123-fix-the-kettle-lid-for-good',
      'risk-assessment-for-the-new-kettle-and-pot',
    ]) {
      expect(looksLikeSecret(harmless, patterns)).toBe(false);
    }
  });

  it('hides inside any JSON value and skips a stored pattern that no longer compiles', () => {
    const patterns = secretPatterns(['(', 'tea-[0-9]{4}']);
    expect(patterns).toHaveLength(1);
    expect(
      hideSecretsDeep(
        { a: ['tea-1234', 5, null], 'tea-9999': { b: 'x tea-0000 y', c: true } },
        patterns,
      ),
    ).toEqual({ a: [hiddenText, 5, null], [hiddenText]: { b: `x ${hiddenText} y`, c: true } });
    // The same pattern object hides every time it is used.
    expect(hideSecrets('tea-1111 tea-2222', patterns)).toBe(`${hiddenText} ${hiddenText}`);
    expect(hideSecrets('tea-3333', patterns)).toBe(hiddenText);
  });

  it('takes a user name and password out of every address, with or without patterns', () => {
    expect(
      hideSecrets('Site https://reader:hunter2pass@gitlab.example.invalid/group is set', []),
    ).toBe('Site https://gitlab.example.invalid/group is set');
    expect(
      hideSecretsDeep(
        { url: 'http://ada@jira.example.invalid', ok: 'mail ada@example.invalid' },
        [],
      ),
    ).toEqual({ url: 'http://jira.example.invalid', ok: 'mail ada@example.invalid' });
    expect(
      JSON.parse(hideSecrets('["https://a.example.invalid","ada@example.invalid"]', [])),
    ).toEqual(['https://a.example.invalid', 'ada@example.invalid']);
  });
});
