import { createStore, type StoreApi } from 'zustand';

// What the user picked for a thread that does not exist yet. UI state only: the thread is created
// on the server when the first message is sent.
export interface DraftState {
  readonly providerInstanceId: string | undefined;
  readonly projectId: string | undefined;
  readonly cwd: string | undefined;
}

export type DraftStore = StoreApi<DraftState>;

export const createDraftStore = (): DraftStore =>
  createStore<DraftState>(() => ({
    providerInstanceId: undefined,
    projectId: undefined,
    cwd: undefined,
  }));
