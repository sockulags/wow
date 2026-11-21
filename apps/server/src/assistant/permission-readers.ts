import {
  AssistantPermission,
  assistantPermissionLabels,
  atMinute,
  isoDate,
  localDate,
} from '@wow/contracts';
import { gte } from 'drizzle-orm';
import { z } from 'zod';
import * as t from '../db/schema.js';
import { calendarPrefs } from './outputs.js';
import type { Reader } from './readers.js';

// What the assistant may do without asking (chief of staff spec 4 to 8), for it to read before it
// acts and to say back to the person.
export const permissionReaders = {
  read_permissions: {
    description:
      'Whether you may act under standing permissions, and each permission the person gave: its kind, the projects and workflows it covers, its end date, daily limit and whether it is paused, with how often it was used today. To ask for one, propose a change to the assistant.permissions setting; it waits for their yes.',
    input: z.object({}).strict(),
    read: (_args, deps) => {
      const parsed = AssistantPermission.array().safeParse(
        deps.settings.get('assistant.permissions'),
      );
      const permissions = parsed.success ? parsed.data : [];
      const { zone } = calendarPrefs(deps);
      const day = localDate(deps.clock(), zone);
      const today = isoDate(day);
      const uses = deps.db
        .select()
        .from(t.assistantPermissionUses)
        .where(gte(t.assistantPermissionUses.at, atMinute(day, 0, zone).toISOString()))
        .all();
      return {
        delegation: deps.settings.get('assistant.delegation'),
        today,
        permissions: permissions.map((permission) => ({
          ...permission,
          label: assistantPermissionLabels[permission.kind],
          usedToday: uses.filter((use) => use.permissionId === permission.id).length,
        })),
      };
    },
  } satisfies Reader<z.ZodObject<Record<string, never>>>,
};
