// Backlog bodies are markdown; Jira's REST API v2 takes the description as wiki markup and shows
// markdown literally (`##`, `**`). This converts the markdown people write in an item: headings,
// emphasis, inline code, fenced code, links, lists (nested by indentation), quotes, rules and
// tables. Anything it does not know passes through as text.

const fence = /^\s*(```|~~~)\s*([\w+-]*)\s*$/;
const heading = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const listItem = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
const rule = /^\s*([-*_])(\s*\1){2,}\s*$/;
const quote = /^\s*>\s?(.*)$/;
const tableRow = /^\s*\|(.*)\|\s*$/;
const tableDivider = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/;

// Inline code is cut out first so emphasis markers inside it stay as they are.
export function inlineToJira(text: string): string {
  const codes: string[] = [];
  const protectedText = text.replace(/`([^`]+)`/g, (_, code: string) => {
    codes.push(code);
    return `\uE000${codes.length - 1}\uE000`;
  });
  const converted = protectedText
    // Images before links: ![alt](url) → !url!
    .replace(/!\[[^\]]*\]\(([^)\s]+)[^)]*\)/g, '!$1!')
    .replace(/\[([^\]]+)\]\(([^)\s]+)[^)]*\)/g, '[$1|$2]')
    .replace(/<(https?:\/\/[^>\s]+)>/g, '[$1]')
    // Bold first, written with a placeholder so the italic pass does not see it.
    .replace(/(\*\*|__)(?=\S)(.+?)(?<=\S)\1/g, '\uE001$2\uE001')
    .replace(/(^|[^\w*])\*(?=\S)([^*]+?)(?<=\S)\*(?!\w)/g, '$1_$2_')
    .replace(/~~(?=\S)(.+?)(?<=\S)~~/g, '-$1-')
    .replaceAll('\uE001', '*');
  return converted.replace(/\uE000(\d+)\uE000/g, (_, index: string) => `{{${codes[Number(index)]}}}`);
}

const cells = (row: string): string[] =>
  (tableRow.exec(row)?.[1] ?? row).split('|').map((cell) => inlineToJira(cell.trim()));

export function markdownToJira(markdown: string): string {
  const lines = markdown.replaceAll('\r\n', '\n').split('\n');
  const out: string[] = [];
  // Indentation of each open list level, so a nested item gets one more marker.
  let indents: number[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index] ?? '';
    const opened = fence.exec(line);
    if (opened) {
      const marker = opened[1] ?? '```';
      const language = opened[2] ?? '';
      const body: string[] = [];
      index += 1;
      while (index < lines.length && !(lines[index] ?? '').trim().startsWith(marker)) {
        body.push(lines[index] ?? '');
        index += 1;
      }
      index += 1;
      out.push(language ? `{code:${language}}` : '{code}', ...body, '{code}');
      indents = [];
      continue;
    }
    const next = lines[index + 1] ?? '';
    if (tableRow.test(line) && tableDivider.test(next)) {
      out.push(`||${cells(line).join('||')}||`);
      index += 2;
      while (index < lines.length && tableRow.test(lines[index] ?? '')) {
        out.push(`|${cells(lines[index] ?? '').join('|')}|`);
        index += 1;
      }
      indents = [];
      continue;
    }
    index += 1;
    const titled = heading.exec(line);
    if (titled) {
      out.push(`h${titled[1]?.length ?? 1}. ${inlineToJira(titled[2] ?? '')}`);
      indents = [];
      continue;
    }
    if (rule.test(line)) {
      out.push('----');
      indents = [];
      continue;
    }
    const item = listItem.exec(line);
    if (item) {
      const indent = (item[1] ?? '').replaceAll('\t', '  ').length;
      while (indents.length > 0 && indent < (indents.at(-1) ?? 0)) indents.pop();
      if (indents.length === 0 || indent > (indents.at(-1) ?? 0)) indents.push(indent);
      const bullet = /^\d/.test(item[2] ?? '') ? '#' : '*';
      out.push(`${bullet.repeat(indents.length)} ${inlineToJira(item[3] ?? '')}`);
      continue;
    }
    const quoted = quote.exec(line);
    if (quoted) {
      out.push(`bq. ${inlineToJira(quoted[1] ?? '')}`);
      indents = [];
      continue;
    }
    if (line.trim() === '') indents = [];
    out.push(inlineToJira(line));
  }
  return out.join('\n');
}

// Jira labels are single words: spaces become dashes.
export const jiraLabel = (tag: string): string => tag.trim().replace(/\s+/g, '-');
