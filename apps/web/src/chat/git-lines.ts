import {
  changeRequestWords,
  type ChangeRequestOpenedItemPayload,
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
