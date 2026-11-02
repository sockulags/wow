import type { TurnStartParams, ThreadStartParams } from './protocol/generated/index.js';
import { CodexError } from './connection.js';

type ApprovalPolicy = NonNullable<ThreadStartParams['approvalPolicy']>;
type SandboxMode = NonNullable<ThreadStartParams['sandbox']>;
type SandboxPolicy = NonNullable<TurnStartParams['sandboxPolicy']>;

interface PermissionMode {
  readonly label: string;
  readonly approvalPolicy: ApprovalPolicy;
  readonly sandbox: SandboxMode;
}

// The permission modes a codex thread offers, named after the presets in the codex CLI. A wow
// thread stores the key; codex gets an approval policy and a sandbox for it.
export const codexPermissionModes = {
  'read-only': {
    label: 'Read only',
    approvalPolicy: 'on-request',
    sandbox: 'read-only',
  },
  auto: {
    label: 'Auto (workspace write, ask outside it)',
    approvalPolicy: 'on-request',
    sandbox: 'workspace-write',
  },
  untrusted: {
    label: 'Ask for every untrusted command',
    approvalPolicy: 'untrusted',
    sandbox: 'workspace-write',
  },
  'full-access': {
    label: 'Full access (no sandbox, never ask)',
    approvalPolicy: 'never',
    sandbox: 'danger-full-access',
  },
} as const satisfies Record<string, PermissionMode>;

export type CodexPermissionMode = keyof typeof codexPermissionModes;

export function permissionMode(key: string): PermissionMode {
  const mode = (codexPermissionModes as Record<string, PermissionMode>)[key];
  if (!mode) {
    const known = Object.keys(codexPermissionModes).join(', ');
    throw new CodexError('state', `Unknown codex permission mode "${key}". Use one of: ${known}`);
  }
  return mode;
}

// turn/start takes a full sandbox policy rather than a mode. Only sent when the mode changed
// since the thread started, because it replaces what config.toml set (network access, roots).
export function sandboxPolicy(mode: SandboxMode): SandboxPolicy {
  switch (mode) {
    case 'read-only':
      return { type: 'readOnly', networkAccess: false };
    case 'workspace-write':
      return {
        type: 'workspaceWrite',
        writableRoots: [],
        networkAccess: false,
        excludeTmpdirEnvVar: false,
        excludeSlashTmp: false,
      };
    case 'danger-full-access':
      return { type: 'dangerFullAccess' };
  }
}
