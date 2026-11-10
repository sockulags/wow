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
// A fence or table can sit inside a list item or a quote. Its lines then start with that
// container's indentation and `>` marks, and its first line may follow the list marker.
const inContainer = (line: string) => line.replace(/^[\s>]+/, '');
const afterMarker = (line: string) => inContainer(line).replace(/^(?:[-*+]|\d{1,9}[.)])\s+/, '');
const delimiterRow = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;

// While a message streams, the part that is still being written (a fence without its closing
// line, or a table at the very end that may still get rows) is held back as plain text, so a
// half table or half diagram never flickers through wrong shapes.
export function splitUnfinished(text: string): { readonly done: string; readonly pending: string } {
  const lines = text.split('\n');
  let fence: { readonly marker: string; readonly start: number } | undefined;
  let runStart = 0;
  for (const [index, line] of lines.entries()) {
    if (fence) {
      const closing = fenceClosing.exec(inContainer(line))?.[1];
      if (closing?.startsWith(fence.marker)) {
        fence = undefined;
        runStart = index + 1;
      }
      continue;
    }
    const opening = fenceOpening.exec(afterMarker(line));
    if (opening?.[1] && !(opening[1].startsWith('`') && (opening[2] ?? '').includes('`'))) {
      fence = { marker: opening[1], start: index };
    } else if (inContainer(line) === '') {
      runStart = index + 1;
    }
  }
  let cut = fence?.start ?? lines.length;
  if (!fence) {
    for (let index = runStart; index + 1 < lines.length; index += 1) {
      const next = inContainer(lines[index + 1] ?? '');
      if ((lines[index] ?? '').includes('|') && next.includes('-') && delimiterRow.test(next)) {
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
