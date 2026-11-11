import {
  changeRequestName,
  fillTemplate,
  runEventHost,
  triggerEventLabel,
  type RunEvent,
} from '@wow/contracts';

// Renders the `workflows.handoverTemplate` setting with `fillTemplate`, so an unused part of the
// template (no backlog item, first step) leaves no stray heading.

export interface HandoverValues {
  readonly previousStep: string;
  readonly previousMessage: string;
  readonly backlogBody: string;
  readonly previousArtifacts: string;
  // The error of the step the run came from, when that step failed and a rule sent the run on.
  readonly previousError: string;
  readonly expectedArtifacts: string;
  // For a run an event trigger started: what happened and on which pull request. Empty
  // otherwise. A review comment is named by its link and author, never by its text.
  readonly event: string;
  readonly pullRequestNumber: string;
  // "Pull request #14" or "Merge request !12", in the host's words.
  readonly pullRequestName: string;
  readonly pullRequestUrl: string;
  readonly pullRequestBranch: string;
  readonly commentUrl: string;
  readonly commentAuthor: string;
}

const noEvent = {
  event: '',
  pullRequestNumber: '',
  pullRequestName: '',
  pullRequestUrl: '',
  pullRequestBranch: '',
  commentUrl: '',
  commentAuthor: '',
};

// A name from the host as one short word in a prompt: letters, digits and the few marks account
// names use. Anything else someone could put into a display name is dropped.
const plainName = (name: string): string => name.replace(/[^\p{L}\p{N}._@[\]-]/gu, '').slice(0, 64);

export function eventValues(
  event: RunEvent | null | undefined,
): Pick<HandoverValues, keyof typeof noEvent> {
  if (!event) return noEvent;
  const host = runEventHost(event);
  return {
    event: triggerEventLabel(event.event, host).toLowerCase(),
    pullRequestNumber: String(event.number),
    pullRequestName: changeRequestName({ host, number: event.number }),
    pullRequestUrl: event.url,
    pullRequestBranch: event.branch,
    commentUrl: event.commentUrl ?? '',
    commentAuthor:
      event.commentUrl === null ? '' : plainName(event.commentAuthor ?? '') || 'someone',
  };
}

export const renderHandover = (template: string, values: HandoverValues): string =>
  fillTemplate(template, { ...values });

// What `workflows.sendBackTemplate` can name: the reviewer's note, the step's skill and the
// number of the attempt that starts.
export interface SendBackValues {
  readonly note: string;
  readonly skill: string;
  readonly attempt: string;
}

export const renderSendBack = (template: string, values: SendBackValues): string =>
  fillTemplate(template, { ...values });

// What `workflows.goBackTemplate` can name: the step whose rule sent the run back, the fact that
// held, what that step ended with, and this step's skill and attempt.
export interface GoBackValues {
  readonly fromStep: string;
  readonly reason: string;
  readonly message: string;
  readonly skill: string;
  readonly attempt: string;
}

export const renderGoBack = (template: string, values: GoBackValues): string =>
  fillTemplate(template, { ...values });

// What `workflows.unitPromptTemplate` can name: the unit a plan run started the run for.
export interface UnitPromptValues {
  readonly intentId: string;
  readonly unitKey: string;
  readonly unitTitle: string;
  // Empty for a step that gets wow-pull-request, which asks for the line itself.
  readonly intentUnitLine: string;
}

export const renderUnitPrompt = (template: string, values: UnitPromptValues): string =>
  fillTemplate(template, { ...values });

export const bulletList = (lines: readonly string[]): string =>
  lines.map((line) => `- ${line}`).join('\n');

// The step prompt: the skill invocation for the step's provider and the step's extra prompt,
// then the unit text of a unit's run, then the rendered handover, each after a blank line.
export function stepPrompt(
  invocation: string,
  extraPrompt: string | undefined,
  handover: string,
  unit = '',
) {
  const head = [invocation, extraPrompt?.trim() ?? ''].filter((part) => part !== '').join(' ');
  return [head, unit, handover].filter((part) => part !== '').join('\n\n');
}
