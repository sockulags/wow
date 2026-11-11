// Fills a text template: `{{name}}` is replaced by the value and `{{#name}}…{{/name}}` is kept
// only when the value is not empty, so an unused part of the template leaves no stray heading.
// The workflow texts in the settings and the built-in skills use it.

const SECTION = /\{\{#(\w+)\}\}([\s\S]*?)\{\{\/\1\}\}/g;
const PLACEHOLDER = /\{\{(\w+)\}\}/g;
// Each value goes in after the template's own blank lines are tidied, so what a value says
// (a note or a message with several blank lines, a code block) arrives as it was written.
const SLOT = /\uE000(\d+)\uE001/g;

export type TemplateValues = Readonly<Record<string, string>>;

const valueOf = (values: TemplateValues, name: string): string =>
  Object.hasOwn(values, name) ? (values[name] ?? '') : '';

export function fillTemplate(template: string, values: TemplateValues): string {
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
