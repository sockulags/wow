import type {
  DiffFileStatus,
  RunDiffFile,
  RunDiffStatus,
  StepRun,
  WorkflowRun,
} from '@wow/contracts';
import { createStore } from 'zustand';
import { formatBytes } from '@/panel/viewer';
import { reviewedStep } from './model';

// The Changes tab of a run (review loop spec 11 to 13). The server compares the folder with the
// run's base and says which step changed which file; this is how the tab reads its answer.

// The run view's tabs (review loop spec 14). Steps is the run itself and has no `tab` in the
// address; the others are what a gate asks the user to look at.
export const runTabs = [
  { id: 'steps', label: 'Steps' },
  { id: 'path', label: 'Path' },
  { id: 'changes', label: 'Changes' },
  { id: 'artifacts', label: 'Artifacts' },
  { id: 'pullRequest', label: 'Pull request' },
  { id: 'ticket', label: 'Ticket' },
  { id: 'pages', label: 'Pages' },
] as const;

export type RunTab = (typeof runTabs)[number]['id'];
export type ReviewTab = Exclude<RunTab, 'steps'>;

const isReviewTab = (value: unknown): value is ReviewTab =>
  value !== 'steps' && runTabs.some((tab) => tab.id === value);

// The run view's address: `?tab=<tab>` opens a tab; on Changes, `file` is the file whose diff
// shows and `stepOnly` narrows the list to the step under review, so palette commands can do
// all three.
export interface RunSearch {
  tab?: ReviewTab;
  file?: string;
  stepOnly?: true;
}

export function validateRunSearch(search: Record<string, unknown>): RunSearch {
  const tab = search['tab'];
  if (!isReviewTab(tab)) return {};
  if (tab !== 'changes') return { tab };
  const file = search['file'];
  return {
    tab: 'changes',
    ...(typeof file === 'string' && file !== '' ? { file } : {}),
    ...(search['stepOnly'] === true ? { stepOnly: true as const } : {}),
  };
}

// The step whose changes are marked: the one a gate asks the user to review, else the step that
// ended last with its file hashes stored. After a loop that is not the last step of the list,
// and the server marks what that step's latest attempt changed (workflow branches spec 19).
export function stepUnderReview(run: WorkflowRun): StepRun | undefined {
  const reviewed = reviewedStep(run);
  if (reviewed) return reviewed;
  const hashed = (stepId: string) =>
    run.steps.find((step) => step.stepId === stepId && step.fileHashes !== undefined);
  const visit = run.path?.findLast((entry) => entry.ended === 'done' && hashed(entry.stepId));
  return visit ? hashed(visit.stepId) : run.steps.findLast((step) => step.fileHashes !== undefined);
}

export const changedByStep = (file: RunDiffFile, step: StepRun | undefined): boolean =>
  step !== undefined && file.changedBy.includes(step.stepId);

export function visibleFiles(
  files: readonly RunDiffFile[],
  step: StepRun | undefined,
  stepOnly: boolean,
): RunDiffFile[] {
  return stepOnly ? files.filter((file) => changedByStep(file, step)) : [...files];
}

export const fileStatusLabels: Readonly<Record<DiffFileStatus, string>> = {
  added: 'Added',
  modified: 'Changed',
  renamed: 'Renamed',
  deleted: 'Deleted',
};

export const fileStatusLetters: Readonly<Record<DiffFileStatus, string>> = {
  added: 'A',
  modified: 'M',
  renamed: 'R',
  deleted: 'D',
};

const sizeOf = (file: RunDiffFile) => (file.size === null ? '' : ` · ${formatBytes(file.size)}`);

// What stands in for the lines of a file that shows status and size only (spec 12).
export function unshownReason(file: RunDiffFile): string | undefined {
  if (file.content === 'binary') return `Binary file${sizeOf(file)}`;
  if (file.content === 'tooLarge') return `Too large to show${sizeOf(file)}`;
  return undefined;
}

export const lineChanges = (file: RunDiffFile): string =>
  unshownReason(file) ?? `+${file.added ?? 0} −${file.removed ?? 0}`;

// Why the tab has nothing to compare, in the user's words (spec 13).
export function emptyReason(
  status: Exclude<RunDiffStatus, 'ok'>,
  message: string | null,
): { readonly title: string; readonly description: string } {
  switch (status) {
    case 'noRepository':
      return {
        title: 'Not a Git repository',
        description:
          'The folder this run works in is not a Git repository, so wow cannot tell what changed. The rest of the run works as usual.',
      };
    case 'gitUnavailable':
      return {
        title: 'Git was not found',
        description:
          'Git is not installed or not on the PATH of the wow server, so wow cannot tell what changed. The rest of the run works as usual.',
      };
    case 'folderMissing':
      return {
        title: 'Folder missing',
        description: 'The folder this run worked in is no longer there.',
      };
    case 'noBase':
      return {
        title: 'No base recorded',
        description:
          'This run did not record the commit it started from, so there is nothing to compare with. Runs started from now on in a repository with a commit do.',
      };
    case 'baseMissing':
      return {
        title: 'The starting commit is gone',
        description: 'The commit this run started from is no longer in the repository.',
      };
    case 'failed':
      return {
        title: 'Git could not compare the folder',
        description: message ?? 'Git gave no reason.',
      };
  }
}

export interface DiffLine {
  readonly kind: 'hunk' | 'add' | 'remove' | 'context' | 'note';
  readonly text: string;
  // Line numbers in the base and in the folder; absent on the side a line is not on.
  readonly oldNumber?: number;
  readonly newNumber?: number;
}

// Reads a unified diff from its first hunk on into rows with their line numbers.
export function parsePatch(patch: string): DiffLine[] {
  const lines = patch.split('\n');
  if (lines.at(-1) === '') lines.pop();
  const rows: DiffLine[] = [];
  let oldNumber = 0;
  let newNumber = 0;
  for (const line of lines) {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk) {
      oldNumber = Number(hunk[1]);
      newNumber = Number(hunk[2]);
      rows.push({ kind: 'hunk', text: line });
    } else if (line.startsWith('+')) {
      rows.push({ kind: 'add', text: line.slice(1), newNumber });
      newNumber += 1;
    } else if (line.startsWith('-')) {
      rows.push({ kind: 'remove', text: line.slice(1), oldNumber });
      oldNumber += 1;
    } else if (line.startsWith('\\')) {
      rows.push({ kind: 'note', text: line.slice(2) });
    } else {
      rows.push({ kind: 'context', text: line.slice(1), oldNumber, newNumber });
      oldNumber += 1;
      newNumber += 1;
    }
  }
  return rows;
}

// The changed files of the run on screen, as the tab last read them, so the palette can offer
// each one. `refresh` counts the times the user asked to read them again.
export interface ChangesState {
  readonly runId: string | undefined;
  readonly files: readonly RunDiffFile[];
  readonly refresh: number;
}

export const changesStore = createStore<ChangesState>(() => ({
  runId: undefined,
  files: [],
  refresh: 0,
}));

export const refreshChanges = (): void =>
  changesStore.setState((state) => ({ refresh: state.refresh + 1 }));
