import type { SettingDefinition } from '@wow/contracts';
import {
  createMemorySettingsSource,
  createSettingsStore,
  type SettingValues,
} from '@wow/client-runtime';
import { createMemoryHistory } from '@tanstack/react-router';
import { render, type RenderResult } from '@testing-library/react';
import type { ReactNode } from 'react';
import { App } from '@/app/app';
import { createAppRouter, type AppRouter } from '@/app/router';
import { createLayoutStore, RuntimeProvider, type Runtime } from '@/app/runtime';

export function createTestRuntime(
  definitions?: Readonly<Record<string, SettingDefinition>>,
  initial: SettingValues = {},
): Runtime {
  return {
    connection: undefined,
    layout: createLayoutStore(),
    settings: createSettingsStore(createMemorySettingsSource(definitions, initial), definitions),
  };
}

export function renderWithRuntime(
  ui: ReactNode,
  runtime: Runtime = createTestRuntime(),
): RenderResult & { runtime: Runtime } {
  return { runtime, ...render(<RuntimeProvider runtime={runtime}>{ui}</RuntimeProvider>) };
}

export async function renderApp(
  path = '/calendar',
  runtime: Runtime = createTestRuntime(),
): Promise<RenderResult & { runtime: Runtime; router: AppRouter }> {
  const router = createAppRouter(createMemoryHistory({ initialEntries: [path] }));
  await router.load();
  const result = render(<App runtime={runtime} router={router} />);
  return { runtime, router, ...result };
}
