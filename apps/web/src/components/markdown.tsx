import { lazy, Suspense } from 'react';
import { cn } from '@/lib/utils';

// The one markdown renderer (review loop spec 1 to 5) for assistant messages, backlog bodies and
// publish previews. react-markdown with GFM builds React elements, never HTML strings, and there
// is no raw HTML plugin, so markup in a message shows as text. The library loads on first use, in
// its own chunk; until then the text shows as written.
//
//   <Markdown text={message} streaming={item.streaming} />

const MarkdownBody = lazy(() => import('./markdown-body'));

// Links open only for these; anything else (javascript:, file:, relative paths) shows as text.
export const safeHref = (href: string | undefined): string | undefined =>
  href !== undefined && /^(https?:|mailto:)/i.test(href.trim()) ? href.trim() : undefined;

const fenceOpening = /^(`{3,}|~{3,})(.*)$/;
const fenceClosing = /^(`{3,}|~{3,})\s*$/;
const quoteMarks = /^(?: {0,3}> ?)+/;
const listMarker = /^(?:[-*+]|\d{1,9}[.)])(?: +|$)/;
const indentOf = (line: string) =>
  (/^[ \t]*/.exec(line)?.[0] ?? '').replaceAll('\t', '    ').length;
// A table can sit inside a list item or a quote; its lines then start with that container's
// indentation and `>` marks.
const inContainer = (line: string) => line.replace(/^[\s>]+/, '');
// A row of dashes without a pipe or colon is a heading underline or a rule, not a table.
const delimiterRow = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;
const isDelimiterRow = (line: string) => /[|:]/.test(line) && delimiterRow.test(line);

type Fence = {
  readonly marker: string;
  readonly start: number;
  // The quote and the list item content column the fence sits in; it ends when they end.
  readonly quoted: boolean;
  readonly indent: number;
};

// While a message streams, the part that is still being written (a fence without its closing
// line, or a table at the very end that may still get rows) is held back as plain text, so a
// half table or half diagram never flickers through wrong shapes. A fence counts only where
// markdown reads one: at most three spaces in from its quote or list item, since four make an
// indented code block.
export function splitUnfinished(text: string): { readonly done: string; readonly pending: string } {
  const lines = text.split('\n');
  let fence: Fence | undefined;
  // Content columns of the open list items, innermost last.
  let items: number[] = [];
  let wasQuoted = false;
  let runStart = 0;
  for (const [index, line] of lines.entries()) {
    const marks = quoteMarks.exec(line)?.[0] ?? '';
    const quoted = marks !== '';
    const rest = line.slice(marks.length);
    const blank = rest.trim() === '';
    let indent = indentOf(rest);
    if (fence) {
      if (quoted === fence.quoted && (blank || indent >= fence.indent)) {
        const closing = indent - fence.indent < 4 ? fenceClosing.exec(rest.trim())?.[1] : undefined;
        if (closing?.startsWith(fence.marker)) {
          fence = undefined;
          runStart = index + 1;
        }
        continue;
      }
      // The quote or list item around the fence ended here, and the fence with it.
      fence = undefined;
      runStart = index;
    }
    if (quoted !== wasQuoted) items = [];
    wasQuoted = quoted;
    if (blank) {
      runStart = index + 1;
      continue;
    }
    const column = indent;
    items = items.filter((item) => item <= column);
    let base = items.at(-1) ?? 0;
    let content = rest.trimStart();
    // The line may open list items, and a fence can follow the last marker on the same line.
    for (let marker = listMarker.exec(content)?.[0]; marker !== undefined && indent - base < 4;) {
      const sign = marker.trimEnd().length;
      const gap = marker.length - sign;
      content = content.slice(marker.length);
      base = indent + sign + (content === '' || gap > 4 ? 1 : gap);
      indent = content === '' || gap <= 4 ? base : indent + marker.length;
      items.push(base);
      marker = listMarker.exec(content)?.[0];
    }
    const opening = indent - base < 4 ? fenceOpening.exec(content) : null;
    if (opening?.[1] && !(opening[1].startsWith('`') && (opening[2] ?? '').includes('`'))) {
      fence = { marker: opening[1], start: index, quoted, indent: base };
    }
  }
  let cut = fence?.start ?? lines.length;
  if (!fence) {
    for (let index = runStart; index + 1 < lines.length; index += 1) {
      if (
        (lines[index] ?? '').includes('|') &&
        isDelimiterRow(inContainer(lines[index + 1] ?? ''))
      ) {
        cut = index;
        break;
      }
    }
  }
  return { done: lines.slice(0, cut).join('\n'), pending: lines.slice(cut).join('\n') };
}

const plain = 'whitespace-pre-wrap';

export function Markdown({
  text,
  streaming = false,
  className,
}: {
  readonly text: string;
  // The text is still growing: an unfinished table or fence at its end stays plain text.
  readonly streaming?: boolean | undefined;
  readonly className?: string | undefined;
}) {
  const { done, pending } = streaming ? splitUnfinished(text) : { done: text, pending: '' };
  return (
    <div
      data-testid="markdown"
      className={cn('flex min-w-0 flex-col gap-2 text-sm leading-relaxed', className)}
    >
      {done.trim() !== '' && (
        <Suspense fallback={<p className={plain}>{done}</p>}>
          <MarkdownBody text={done} />
        </Suspense>
      )}
      {pending !== '' && (
        <p data-testid="markdown-pending" className={plain}>
          {pending}
        </p>
      )}
    </div>
  );
}
