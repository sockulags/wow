// Files mentioned with `@` (agent workbench spec 56). The message names each on its first line as
// `@path`, as Claude Code and Codex read a mention, and carries the paths beside the text so the
// thread shows chips instead of that line.

export const mentionLine = (files: readonly string[]): string =>
  files.map((file) => `@${file}`).join(' ');

export function withMentions(text: string, files: readonly string[]): string {
  if (files.length === 0) return text;
  const line = mentionLine(files);
  return text === '' ? line : `${line}\n\n${text}`;
}

// The text as typed, for a message whose chips show its mentions. A text that does not start
// with them (stored otherwise) is shown whole.
export function withoutMentions(text: string, files: readonly string[]): string {
  if (files.length === 0) return text;
  const line = mentionLine(files);
  if (text === line) return '';
  return text.startsWith(`${line}\n\n`) ? text.slice(line.length + 2) : text;
}

// A queued message's text without the mention lines its joined messages started with, for Edit:
// the files come back as chips and Send names them again.
export function withoutMentionLines(text: string, files: readonly string[]): string {
  if (files.length === 0) return text;
  const names = [...files].sort((a, b) => b.length - a.length);
  const onlyMentions = (paragraph: string): boolean => {
    let rest = paragraph;
    while (rest !== '') {
      const name = names.find((file) => rest === `@${file}` || rest.startsWith(`@${file} `));
      if (name === undefined) return false;
      rest = rest.slice(name.length + 1).replace(/^ /, '');
    }
    return true;
  };
  return text
    .split('\n\n')
    .filter((paragraph) => !onlyMentions(paragraph))
    .join('\n\n');
}
