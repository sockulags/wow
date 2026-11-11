import {
  ProjectWorkOffer,
  SecretFieldRequest,
  SecretRef,
  assistantProjectWorkTool,
  assistantSecretFieldTool,
  settingGroupTitles,
} from '@wow/contracts';
import { eq } from 'drizzle-orm';
import * as t from '../db/schema.js';
import { RpcFault } from '../rpc/router.js';
import { guideFor, serviceOfToken } from './guides.js';
import type { Reader } from './readers.js';

// Tools that put something in front of the user and change nothing (app assistant spec 3, 14).
// The conversation draws the card from the tool call itself, so the answer only has to tell the
// agent what the user now sees.

export const asks = {
  [assistantSecretFieldTool]: {
    description:
      'Shows the user a field for a secret setting (a host token), with Save and Test connection. Use it whenever a token or password is needed: never ask for one in the conversation. key is the setting, such as trackers.gitlab.token; give projectId for a project\'s own value. The value goes to the secret store and you never see it; you only learn "set" or "not set" (read_settings), and test_connection says whether it works.',
    input: SecretFieldRequest,
    read: async ({ key, projectId }, deps) => {
      const definition = deps.registry[key];
      if (!definition?.secret) {
        throw new RpcFault(
          'rejected',
          `${key} is not a secret setting. Read the settings for one.`,
        );
      }
      let target = `Settings → ${settingGroupTitles[definition.group]}, for every project`;
      if (projectId !== undefined) {
        const project = deps.db.select().from(t.projects).where(eq(t.projects.id, projectId)).get();
        if (!project) throw new RpcFault('not_found', `No project ${projectId}`);
        if (definition.scope === 'global') {
          throw new RpcFault('rejected', `${definition.label} is stored once for every project.`);
        }
        target = `Settings → Projects → ${project.name}`;
      }
      const ref = deps.settings.resolve(key, { projectId }).value;
      const parsed = SecretRef.safeParse(ref);
      const set = parsed.success && (await deps.secrets.names()).includes(parsed.data.secretRef);
      // A host token's card shows the guide's steps above the field (spec 15), from this answer.
      const service = serviceOfToken(key);
      return {
        outcome: 'shown',
        setting: { key, label: definition.label },
        target,
        secret: set ? 'set' : 'not set',
        ...(service ? { guide: await guideFor(service, projectId, deps) } : {}),
        note: service
          ? "The user sees the field in the conversation with the guide's steps above it. Say where to create the token, which rights it needs and what to copy, from the guide and not from memory, then wait for them. When they say it is saved, read the setting or run test_connection."
          : 'The user sees the field in the conversation. Say where to create the value and which rights it needs, then wait for them. When they say it is saved, read the setting or run test_connection.',
      };
    },
  } satisfies Reader<typeof SecretFieldRequest>,
  [assistantProjectWorkTool]: {
    description:
      "For a request that is not about operating wow (write code, explain an error in a project, review a file): shows the user a button that opens a new thread in the chat view with text. Give the user's request as text. Do not attempt the work yourself.",
    input: ProjectWorkOffer,
    read: () => ({
      outcome: 'offered',
      note: 'The user sees a button that opens a new chat thread with this text. Say that the chat view is for this work; there is nothing more for you to do with it.',
    }),
  } satisfies Reader<typeof ProjectWorkOffer>,
} as const;

export type AskName = keyof typeof asks;
