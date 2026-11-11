import { describe, expect, it } from 'vitest';
import {
  ProviderKind,
  ProviderModel,
  isDangerousMode,
  nextPermissionMode,
  permissionModeOption,
  providerChatOptions,
  settingsRegistry,
} from './index.js';

// Agent workbench U1: the facts the composer bar, the palette and Shift+Tab read.
describe('model bar facts (agent workbench spec 3, 4, 7, 8)', () => {
  it('cycles Claude Code through Ask, Accept edits and Plan only, never Bypass', () => {
    expect(nextPermissionMode('claude', 'default')).toBe('acceptEdits');
    expect(nextPermissionMode('claude', 'acceptEdits')).toBe('plan');
    expect(nextPermissionMode('claude', 'plan')).toBe('default');
    // From a mode outside the cycle the key starts it again.
    expect(nextPermissionMode('claude', 'bypassPermissions')).toBe('default');
    expect(nextPermissionMode('claude', 'dontAsk')).toBe('default');
  });

  it('cycles Codex through Read only, Auto and untrusted, skipping Full access', () => {
    expect(nextPermissionMode('codex', 'read-only')).toBe('auto');
    expect(nextPermissionMode('codex', 'auto')).toBe('untrusted');
    expect(nextPermissionMode('codex', 'untrusted')).toBe('read-only');
    expect(nextPermissionMode('codex', 'full-access')).toBe('read-only');
  });

  it('keeps every dangerous mode out of every cycle, and every cycle mode is offered', () => {
    for (const kind of ProviderKind.options) {
      const { modeCycle, permissionModes } = providerChatOptions[kind];
      expect(modeCycle.length).toBeGreaterThan(1);
      for (const id of modeCycle) {
        expect(permissionModeOption(kind, id)).toBeDefined();
        expect(isDangerousMode(kind, id)).toBe(false);
      }
      expect(permissionModes.some((mode) => mode.tone === 'danger')).toBe(true);
    }
    expect(isDangerousMode('claude', 'bypassPermissions')).toBe(true);
    expect(isDangerousMode('codex', 'full-access')).toBe(true);
    expect(permissionModeOption('claude', 'plan')?.tone).toBe('plan');
    expect(permissionModeOption('claude', 'acceptEdits')?.tone).toBe('edits');
    expect(permissionModeOption('claude', 'default')?.short).toBe('Ask');
  });

  it('takes a model with or without the optional fields a provider may report', () => {
    const plain = { id: 'm', label: 'M', description: '', efforts: [] };
    expect(ProviderModel.parse(plain)).toEqual(plain);
    const full = { ...plain, defaultEffort: 'medium', isDefault: true, imageInput: false };
    expect(ProviderModel.parse(full)).toEqual(full);
    expect(ProviderModel.safeParse({ ...plain, defaultEffort: '' }).success).toBe(false);
  });

  it('has a keybinding setting for each key of the bar', () => {
    expect(settingsRegistry['keybindings.composerModel'].default).toBe('Mod+Shift+M');
    expect(settingsRegistry['keybindings.composerEffort'].default).toBe('Mod+Shift+E');
    expect(settingsRegistry['keybindings.composerModeCycle'].default).toBe('Shift+Tab');
    expect(settingsRegistry['keybindings.composerLeave'].default).toBe('Escape');
  });
});
