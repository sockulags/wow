import { ProviderKind, providerSetup, type ProviderInstance } from '@wow/contracts';
import type { AppCommand, CommandContext } from '@/app/commands';
import type { ProviderDialog } from '@/app/runtime';
import { agentNames, connectStore } from './connect-step';

const open =
  (dialog: ProviderDialog) =>
  ({ navigate, layout }: CommandContext) => {
    void navigate({ to: '/settings/$group', params: { group: 'providers' } });
    layout.setState({ providerDialog: dialog });
  };

// Palette commands for Settings → Providers: add, detect, and test or edit each instance.
export function providerCommands(instances: readonly ProviderInstance[]): AppCommand[] {
  const commands: AppCommand[] = ProviderKind.options.map((kind) => ({
    id: `providers.add.${kind}`,
    title: `Add ${providerSetup[kind].label} instance`,
    group: 'Settings',
    keywords: ['provider', 'instance', 'account', kind],
    run: open({ type: 'create', kind }),
  }));
  commands.push({
    id: 'providers.detect',
    title: 'Detect installed providers',
    group: 'Settings',
    keywords: ['provider', 'setup', 'onboarding', 'claude', 'codex'],
    run: open({ type: 'wizard' }),
  });
  for (const instance of instances) {
    commands.push(
      {
        id: `providers.test.${instance.id}`,
        title: `Test provider ${instance.name}`,
        value: `Test provider ${instance.name} ${instance.id}`,
        group: 'Settings',
        keywords: ['provider', 'account', 'version', instance.kind],
        run: ({ connection, navigate }) => {
          void navigate({ to: '/settings/$group', params: { group: 'providers' } });
          // The result is stored on the instance; the settings page shows it.
          void connection
            ?.request('provider.test', { providerInstanceId: instance.id })
            .catch(() => undefined);
        },
      },
      {
        id: `providers.edit.${instance.id}`,
        title: `Edit provider ${instance.name}`,
        value: `Edit provider ${instance.name} ${instance.id}`,
        group: 'Settings',
        keywords: ['provider', 'settings', instance.kind],
        run: open({ type: 'edit', providerInstanceId: instance.id }),
      },
    );
  }
  return commands;
}

// While the step "Connect an agent" is on screen (first start, or the Assistant view without a
// provider): Test each agent from the palette, as its card's button does.
export function connectCommands(shown: boolean): AppCommand[] {
  if (!shown) return [];
  return ProviderKind.options.map((kind) => ({
    id: `connect.${kind}`,
    title: `Connect ${agentNames[kind]}`,
    group: 'Settings',
    keywords: ['connect', 'agent', 'provider', 'test', 'first start', kind],
    run: () => connectStore.setState({ wanted: kind }),
  }));
}
