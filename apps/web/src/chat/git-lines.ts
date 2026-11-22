import {
  changeRequestWords,
  type ChangeRequestOpenedItemPayload,
  type ChangesAppliedItemPayload,
  type CommittedItemPayload,
} from '@wow/contracts';

// The words of a commit's and an opened request's line in the conversation, shared by the line,
// Ctrl+F and the Markdown export so all three say the same.

// "Committed 3 files · 4e1d2a0 Ring the bell twice" (spec 29).
export function committedLineText(payload: CommittedItemPayload): string {
  const count = payload.files.length;
  return `Committed ${count} ${count === 1 ? 'file' : 'files'} · ${payload.sha.slice(0, 7)} ${payload.subject}`;
}

// With the note of a hook that stopped after the commit was made, for find and export.
export const committedText = (payload: CommittedItemPayload): string =>
  payload.note ? `${committedLineText(payload)}\n${payload.note}` : committedLineText(payload);

// "Opened pull request #14 · Ring the bell twice" (spec 32).
export function changeRequestLineText(payload: ChangeRequestOpenedItemPayload): string {
  const host = payload.ref.host === 'gitlab' ? 'gitlab' : 'github';
  const { noun, mark } = changeRequestWords[host];
  return `Opened ${noun} ${mark}${payload.number} · ${payload.title}`;
}

const count = (n: number, one: string, many = one) => `${n} ${n === 1 ? one : many}`;

// "Applied to C:\Code\tea · 3 written · 1 merged · 1 deleted · 2 left for you" (spec 8), shared by
// the line, Ctrl+F and the Markdown export.
export function appliedLineText(payload: ChangesAppliedItemPayload): string {
  return [
    payload.undoOf !== undefined ? 'Apply undone' : `Applied to ${payload.projectFolder}`,
    `${payload.written.length} written`,
    ...(payload.merged.length > 0 ? [`${payload.merged.length} merged`] : []),
    `${payload.removed.length} deleted`,
    ...(payload.left.length > 0
      ? [
          payload.undoOf !== undefined
            ? `${count(payload.left.length, 'file')} changed since, left as is`
            : `${payload.left.length} left for you`,
        ]
      : []),
    ...(payload.failed.length > 0 ? [`${payload.failed.length} could not be changed`] : []),
  ].join(' · ');
}

// The line with the files left for the user and those the system refused, for find and export.
export const appliedText = (payload: ChangesAppliedItemPayload): string =>
  [
    appliedLineText(payload),
    ...payload.left.map((file) => `${file.path}: ${file.reason}`),
    ...payload.failed.map((file) => `${file.path}: ${file.message}`),
  ].join('\n');
