import { changeRequestName, runEventHost, triggerEventLabel, type RunEvent } from '@wow/contracts';

// Renders the `workflows.handoverTemplate` setting. `{{name}}` is replaced by the value and
// `{{#name}}…{{/name}}` is kept only when the value is not empty, so an unused part of the
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

const SECTION = /\{\{#(\w+)\}\}([\s\S]*?)\{\{\/\1\}\}/g;
const PLACEHOLDER = /\{\{(\w+)\}\}/g;

type TemplateValues = Readonly<Record<string, string>>;

const valueOf = (values: TemplateValues, name: string): string =>
  Object.hasOwn(values, name) ? (values[name] ?? '') : '';

export const renderHandover = (template: string, values: HandoverValues): string =>
  renderTemplate(template, { ...values });

// What `workflows.sendBackTemplate` can name: the reviewer's note, the step's skill and the
// number of the attempt that starts.
export interface SendBackValues {
  readonly note: string;
  readonly skill: string;
  readonly attempt: string;
}

export const renderSendBack = (template: string, values: SendBackValues): string =>
  renderTemplate(template, { ...values });

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
  renderTemplate(template, { ...values });

// What `workflows.unitPromptTemplate` can name: the unit a plan run started the run for.
export interface UnitPromptValues {
  readonly intentId: string;
  readonly unitKey: string;
  readonly unitTitle: string;
}

export const renderUnitPrompt = (template: string, values: UnitPromptValues): string =>
  renderTemplate(template, { ...values });

// Each value goes in after the template's own blank lines are tidied, so what a value says
// (a note or a message with several blank lines, a code block) arrives as it was written.
const SLOT = /\uE000(\d+)\uE001/g;

function renderTemplate(template: string, values: TemplateValues): string {
  const sections = template.replace(SECTION, (_match, name: string, body: string) =>
    valueOf(values, name).trim() === '' ? '' : body,
  );
  const filled: string[] = [];
  const slotted = sections.replace(PLACEHOLDER, (_match, name: string) => {
    const value = valueOf(values, name);
    if (value === '') return '';
    filled.push(value);
    return `\uE000${filled.length - 1}\uE001`;
  });
  return slotted
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .replace(SLOT, (_match, index: string) => filled[Number(index)] ?? '');
}

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
