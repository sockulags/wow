// Invented intent, spec and plan files in the agent-os format, for the repositories of the host
// tests.

const front = (pairs: Record<string, string | number>) =>
  ['---', ...Object.entries(pairs).map(([key, value]) => `${key}: ${value}`), '---', ''].join('\n');

export const e2eIntentMd = (id: string, title: string, rev = 1) =>
  `${front({ id, status: 'accepted', rev, supersedes: 'null' })}\n# ${title}\n\n## Who and why\n\nInvented for the tests.\n`;

export const e2eSpecMd = (id: string, title: string, builtOn = 1) =>
  `${front({ intent: id, rev: 1, built_on: `intent@${builtOn}`, status: 'accepted' })}\n# ${title}\n\n## Behavior\n\n1. Invented.\n`;

export const e2ePlanMd = (id: string, title: string, body: string, source = 'files') =>
  `${front({ intent: id, rev: 1, built_on: 'spec@1', status: 'accepted', source })}\n# Plan: ${title}\n\n${body}\n`;
