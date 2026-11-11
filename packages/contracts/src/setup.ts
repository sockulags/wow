import { z } from 'zod';
import { AssistantPlace, AssistantProposalLine } from './assistant.js';
import { ProviderKind } from './provider.js';
import { WorkflowStep } from './workflow.js';

// A setup file (app assistant spec 21 to 23): the settings, workflows and templates one person
// sends another, as YAML with a version key. It never holds a secret value, a project folder or
// an account name; a secret that was set is only named under `toFillIn`.

const Id = z.string().min(1);
const Timestamp = z.iso.datetime({ offset: true });

// The newest file version this wow reads and the one it writes.
export const setupFileVersion = 1;

// A step as a file holds it: the provider by its kind, since instance ids are this install's own.
export const SetupStep = WorkflowStep.omit({ providerInstanceId: true })
  .extend({ provider: ProviderKind })
  .strict();
export type SetupStep = z.infer<typeof SetupStep>;

export const SetupWorkflow = z
  .object({
    id: Id,
    name: z.string().min(1),
    templateKind: z.string().min(1).nullable().optional(),
    ownWorkingCopy: z.boolean().optional(),
    forUnits: z.boolean().optional(),
    maxStepVisits: z.number().int().min(1).max(50).nullable().optional(),
    steps: z.array(SetupStep),
  })
  .strict();
export type SetupWorkflow = z.infer<typeof SetupWorkflow>;

// The whole file. A setting's value is checked against its registry entry by the server.
export const SetupFile = z
  .object({
    version: z.number().int().min(1),
    // The wow that wrote it, so an older wow can say which one the file needs.
    wow: z.string().min(1).optional(),
    settings: z.record(z.string(), z.unknown()).optional(),
    toFillIn: z.array(z.string().min(1)).optional(),
    workflows: z.array(SetupWorkflow).optional(),
  })
  .strict();
export type SetupFile = z.infer<typeof SetupFile>;

// A secret setting the file names and leaves for this person to fill in.
export const SetupFillIn = z.object({
  key: z.string().min(1),
  label: z.string().min(1),
  place: AssistantPlace,
});
export type SetupFillIn = z.infer<typeof SetupFillIn>;

// A workflow that is applied but cannot run as it is here, with the reason ("skill not
// installed: brew-report").
export const SetupMark = z.object({
  workflow: z.string().min(1),
  reason: z.string().min(1),
});
export type SetupMark = z.infer<typeof SetupMark>;

// What applying a file would do: what it adds, what it puts in place of a value that is there,
// the workflows it marks and the secrets left to fill in. Nothing in it is a secret value.
export const SetupPreview = z.object({
  added: z.array(AssistantProposalLine),
  replaced: z.array(AssistantProposalLine),
  marked: z.array(SetupMark),
  toFillIn: z.array(SetupFillIn),
});
export type SetupPreview = z.infer<typeof SetupPreview>;

// Why a file is refused: the line (from 1) and the reason. A problem of the whole file has no
// line.
export const SetupProblem = z.object({
  line: z.number().int().min(1).nullable(),
  reason: z.string().min(1),
});
export type SetupProblem = z.infer<typeof SetupProblem>;

export const SetupRead = z.discriminatedUnion('outcome', [
  z.object({ outcome: z.literal('ready'), preview: SetupPreview }),
  z.object({ outcome: z.literal('refused'), problems: z.array(SetupProblem).min(1) }),
]);
export type SetupRead = z.infer<typeof SetupRead>;

// "Save setup to a file": the YAML text, a file name to offer, and what was left out of it
// because it looked like a secret.
export const SetupSaved = z.object({
  text: z.string().min(1),
  fileName: z.string().min(1),
  toFillIn: z.array(z.string().min(1)),
  leftOut: z.array(z.object({ what: z.string().min(1), reason: z.string().min(1) })),
});
export type SetupSaved = z.infer<typeof SetupSaved>;

export const SetupApplicationState = z.enum(['applied', 'undone']);
export type SetupApplicationState = z.infer<typeof SetupApplicationState>;

// One file applied as one step (spec 22), as Settings → Advanced shows it with its Undo. The
// server's whole record, with what Undo puts back, is `SetupApplicationRecord` (commands.ts).
export const SetupApplication = SetupPreview.extend({
  // The id of the command that applied it.
  id: Id,
  at: Timestamp,
  // The file's name as the user picked it.
  name: z.string().min(1),
  state: SetupApplicationState,
  undoneAt: Timestamp.nullable(),
});
export type SetupApplication = z.infer<typeof SetupApplication>;

// The name "Save setup to a file" offers, from an ISO time: plain characters on every platform.
export const setupFileName = (at: string): string => `wow-setup-${at.slice(0, 10)}.yaml`;
