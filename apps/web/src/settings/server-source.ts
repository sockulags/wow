import { SettingRow } from '@wow/contracts';
import {
  dispatch,
  RpcClientError,
  type Connection,
  type SettingValues,
  type SettingWriteResult,
  type SettingsSource,
} from '@wow/client-runtime';
import { z } from 'zod';

// Settings stored on the server: the page shows what the `settings` topic pushes and writes with
// `setting.set` / `setting.reset`, so a change reaches every service and window at once (spec 33).
// The page edits global values; project and provider overrides are written where they belong.

const Rows = z.array(SettingRow);

const issuesOf = (error: unknown): string[] => {
  if (error instanceof RpcClientError && Array.isArray(error.data)) {
    const details = error.data.flatMap((issue: unknown) =>
      typeof issue === 'object' && issue !== null && 'message' in issue
        ? [String(issue.message)]
        : [],
    );
    if (details.length > 0) return details;
  }
  return [error instanceof Error ? error.message : String(error)];
};

export function createServerSettingsSource(connection: Connection): SettingsSource {
  return {
    watch(listener) {
      return connection.subscribe('settings', null, (data) => {
        const parsed = Rows.safeParse(data);
        if (!parsed.success) return;
        const values: Record<string, unknown> = {};
        for (const row of parsed.data) if (row.scope === 'global') values[row.key] = row.value;
        listener(values satisfies SettingValues);
      });
    },
    async write(key, value): Promise<SettingWriteResult> {
      try {
        await dispatch(connection, { type: 'setting.set', key, scope: 'global', value });
        return { ok: true };
      } catch (error) {
        return { ok: false, issues: issuesOf(error) };
      }
    },
    async reset(key) {
      await dispatch(connection, { type: 'setting.reset', key, scope: 'global' });
    },
  };
}
