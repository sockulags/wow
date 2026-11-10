// Renders the `workflows.handoverTemplate` setting. `{{name}}` is replaced by the value and
// `{{#name}}…{{/name}}` is kept only when the value is not empty, so an unused part of the
// template (no backlog item, first step) leaves no stray heading.

export interface HandoverValues {
  readonly previousStep: string;
  readonly previousMessage: string;
  readonly backlogBody: string;
  readonly previousArtifacts: string;
  readonly expectedArtifacts: string;
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

// What `workflows.unitPromptTemplate` can name: the unit a plan run started the run for.
export interface UnitPromptValues {
  readonly intentId: string;
  readonly unitKey: string;
  readonly unitTitle: string;
}

export const renderUnitPrompt = (template: string, values: UnitPromptValues): string =>
  renderTemplate(template, { ...values });

function renderTemplate(template: string, values: TemplateValues): string {
  const sections = template.replace(SECTION, (_match, name: string, body: string) =>
    valueOf(values, name).trim() === '' ? '' : body,
  );
  return sections
    .replace(PLACEHOLDER, (_match, name: string) => valueOf(values, name))
    .replace(/\n{3,}/g, '\n\n')
    .trim();
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
