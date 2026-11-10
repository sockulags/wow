// Jira's wiki markup (what REST API v2 answers as an issue's description) turned into markdown,
// so the app shows a ticket through its one markdown renderer, which never runs HTML (review loop
// spec 4 and 33). Readable, not exact: macros wow does not know keep their text, colours and
// panels lose their frame, and pictures become their file name, because nothing is loaded from
// the host. The inverse, for publishing, is trackers/jira-markup.ts.

const fenceFor = (text: string, mark: '`' | '~'): string => {
  const runs = text.match(mark === '`' ? /`+/g : /~+/g) ?? [];
  const longest = Math.max(0, ...runs.map((run) => run.length));
  return mark.repeat(Math.max(3, longest + 1));
};

// `{{code}}` as a code span long enough that its own backticks stay inside.
const codeSpan = (text: string): string => {
  const runs = text.match(/`+/g) ?? [];
  const ticks = '`'.repeat(Math.max(0, ...runs.map((run) => run.length)) + 1);
  const pad = text.startsWith('`') || text.endsWith('`') ? ' ' : '';
  return `${ticks}${pad}${text}${pad}${ticks}`;
};

const webLink = /^(https?:\/\/|mailto:)/i;

function inlineText(text: string): string {
  return (
    text
      // Colours and anchors carry no words.
      .replace(/\{color(?::[^}]*)?\}/g, '')
      .replace(/\{anchor:[^}]*\}/g, '')
      // Pictures and attachments are not loaded from the host; their name is shown.
      .replace(/!([^\s!|]+)(?:\|[^!\s]*)?!/g, (_, name: string) => `[picture: ${name}]`)
      .replace(/\[([^\]|]*)\|([^\]]+)\]/g, (_, label: string, target: string) => {
        const address = target.trim();
        if (!webLink.test(address)) return label.trim() || address;
        return `[${label.trim() || address}](${address.replace(/[()\s]/g, encodeURIComponent)})`;
      })
      .replace(/\[(~[^\]\s]+)\]/g, (_, user: string) => `@${user.slice(1)}`)
      .replace(/\[([^\]\s|]+)\]/g, (whole, target: string) =>
        webLink.test(target) ? `<${target}>` : whole,
      )
      .replace(/(^|[^\w*])\*(\S(?:[^*]*?\S)?)\*(?=$|[^\w*])/g, '$1**$2**')
      .replace(/(^|[^\w])_(\S(?:[^_]*?\S)?)_(?=$|[^\w])/g, '$1*$2*')
      .replace(/(^|\s)-(\S(?:[^-]*?\S)?)-(?=$|\s|[.,;:!?)])/g, '$1~~$2~~')
      .replace(/(^|[^\w])\+(\S(?:[^+]*?\S)?)\+(?=$|[^\w])/g, '$1$2')
      .replace(/\?\?(\S(?:.*?\S)?)\?\?/g, '*$1*')
      .replace(/\\\\/g, '  \n')
  );
}

// One line's text with its `{{monospace}}` parts kept as written.
function inline(text: string): string {
  return text
    .split(/(\{\{[\s\S]*?\}\})/)
    .map((part) =>
      part.startsWith('{{') && part.endsWith('}}') && part.length > 4
        ? codeSpan(part.slice(2, -2))
        : inlineText(part),
    )
    .join('');
}

const cells = (row: string, separator: '||' | '|'): string[] =>
  row
    .trim()
    .slice(separator.length, row.trim().endsWith(separator) ? -separator.length : undefined)
    .split(separator)
    .map((cell) => inline(cell.trim()).replace(/\|/g, '\\|'));

// `{code:java}` or `{code:title=a.ts|language=ts}`.
const codeLanguage = (options: string): string => {
  for (const part of options.split('|').map((entry) => entry.trim())) {
    const value = part.startsWith('language=') ? part.slice('language='.length) : part;
    if (!value.includes('=') && /^[\w+#-]+$/.test(value)) return value;
  }
  return '';
};

const blockMacro = /^\s*\{(code|noformat)(?::([^}]*))?\}(.*)$/;

export function jiraToMarkdown(wiki: string): string {
  const lines = wiki.replace(/\r\n?/g, '\n').split('\n');
  const out: string[] = [];
  let quoting = false;
  let inTable = false;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    const macro = blockMacro.exec(line);
    if (macro) {
      const name = macro[1] ?? 'code';
      const closing = `{${name}}`;
      const body: string[] = [];
      let rest = macro[3] ?? '';
      // A block that opens and closes on one line, or runs on to the closing macro.
      for (;;) {
        const end = rest.indexOf(closing);
        if (end >= 0) {
          body.push(rest.slice(0, end));
          break;
        }
        body.push(rest);
        index += 1;
        if (index >= lines.length) break;
        rest = lines[index] ?? '';
      }
      while (body.length > 0 && body[0]?.trim() === '') body.shift();
      while (body.length > 0 && body.at(-1)?.trim() === '') body.pop();
      const code = body.join('\n');
      const language = name === 'code' ? codeLanguage(macro[2] ?? '') : '';
      const fence = fenceFor(code, '`');
      const prefix = quoting ? '> ' : '';
      out.push(
        ...[`${fence}${language}`, ...code.split('\n'), fence].map((entry) => prefix + entry),
      );
      inTable = false;
      continue;
    }
    if (/^\s*\{quote\}\s*$/.test(line)) {
      quoting = !quoting;
      inTable = false;
      if (!quoting) out.push('');
      continue;
    }
    // Panels and other frames lose the frame and keep their words.
    if (/^\s*\{(panel|section|column|info|note|warning|tip)(:[^}]*)?\}\s*$/.test(line)) continue;

    const prefix = quoting ? '> ' : '';
    const trimmed = line.trim();
    let converted: string;
    const opensTable = !inTable && trimmed.startsWith('|') && trimmed.length > 1;
    if (opensTable && out.length > 0 && out.at(-1) !== prefix.trimEnd() && out.at(-1) !== '') {
      out.push(prefix.trimEnd());
    }
    if (trimmed.startsWith('||')) {
      const header = cells(trimmed, '||');
      converted = `| ${header.join(' | ')} |\n${prefix}| ${header.map(() => '---').join(' | ')} |`;
      inTable = true;
    } else if (trimmed.startsWith('|') && trimmed.length > 1) {
      const row = cells(trimmed, '|');
      converted = inTable
        ? `| ${row.join(' | ')} |`
        : // GFM needs a header row; a Jira table may have none.
          `| ${row.map(() => ' ').join(' | ')} |\n${prefix}| ${row.map(() => '---').join(' | ')} |\n${prefix}| ${row.join(' | ')} |`;
      inTable = true;
    } else {
      inTable = false;
      const heading = /^h([1-6])\.\s+(.*)$/.exec(trimmed);
      const list = /^([*#]+|-)\s+(.*)$/.exec(trimmed);
      if (heading) {
        converted = `${'#'.repeat(Number(heading[1]))} ${inline(heading[2] ?? '')}`;
      } else if (/^bq\.\s+/.test(trimmed)) {
        converted = `> ${inline(trimmed.replace(/^bq\.\s+/, ''))}`;
      } else if (/^-{4,}$/.test(trimmed)) {
        converted = '---';
      } else if (list) {
        const markers = list[1] === '-' ? '*' : (list[1] ?? '*');
        // Each level is indented by the width of its parent's marker, as markdown nests them.
        const indent = Array.from(markers.slice(0, -1)).map((mark) =>
          mark === '#' ? '   ' : '  ',
        );
        const own = markers.endsWith('#') ? '1.' : '-';
        converted = `${indent.join('')}${own} ${inline(list[2] ?? '')}`;
      } else {
        converted = inline(line);
      }
    }
    out.push(prefix + converted);
  }
  return out
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
