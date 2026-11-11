import { createStore, type StoreApi } from 'zustand';

// What the user picked for a thread that does not exist yet. UI state only: the thread is created
// on the server when the first message is sent.
export interface DraftState {
  readonly providerInstanceId: string | undefined;
  readonly projectId: string | undefined;
  readonly cwd: string | undefined;
  // The first message's text, put in the composer when the draft opens.
  readonly text?: string | undefined;
  // The model, effort and mode to start with on this instance instead of the usual defaults
  // (`/clear` starts the new thread as the old one was, agent workbench spec 59).
  readonly settings?:
    | {
        readonly providerInstanceId: string;
        readonly model: string;
        readonly effort: string;
        readonly permissionMode: string;
      }
    | undefined;
}

export type DraftStore = StoreApi<DraftState>;

export const createDraftStore = (): DraftStore =>
  createStore<DraftState>(() => ({
    providerInstanceId: undefined,
    projectId: undefined,
    cwd: undefined,
  }));
