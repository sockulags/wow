import { Skill } from '@wow/contracts';
import { z } from 'zod';

// What is typed in a thread's composer and not sent yet, text and chips, kept per thread in the
// web app's own storage so it comes back after switching threads and after a restart (agent
// workbench spec 49). A draft is unsent input: the server never sees it. A queued message is
// the server's (spec 50).

export interface ComposerDraft {
  readonly text: string;
  readonly skills: readonly Skill[];
}

const StoredDraft = z.object({ text: z.string(), skills: z.array(Skill) });

const storageKey = (key: string) => `wow.composerDraft.${key}`;

// Storage can be missing or full (a locked-down browser); a draft is then kept only on screen.
function storage(): Storage | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}

export const emptyDraft: ComposerDraft = { text: '', skills: [] };

export function readDraft(key: string): ComposerDraft {
  try {
    const raw = storage()?.getItem(storageKey(key));
    if (raw === null || raw === undefined) return emptyDraft;
    const parsed = StoredDraft.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : emptyDraft;
  } catch {
    return emptyDraft;
  }
}

// An empty draft is removed, so sending clears it.
export function writeDraft(key: string, draft: ComposerDraft): void {
  try {
    if (draft.text === '' && draft.skills.length === 0) {
      storage()?.removeItem(storageKey(key));
      return;
    }
    storage()?.setItem(storageKey(key), JSON.stringify({ text: draft.text, skills: draft.skills }));
  } catch {
    // Kept on screen only; see storage().
  }
}

export const clearDraft = (key: string): void => writeDraft(key, emptyDraft);
