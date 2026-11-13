import { ChevronDownIcon, ChevronUpIcon, SearchIcon, XIcon } from 'lucide-react';
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { useStore } from 'zustand';
import { IconButton } from '@/components/hint';
import { Input } from '@/components/ui/input';
import {
  conversationText,
  findCountText,
  findMatches,
  foldCase,
  keepCurrent,
  softBreaks,
  type FindMatch,
  type FindSource,
  type MarkdownCache,
} from './find';
import { openAll, type OpenStore } from './open-state';

// The find bar above a chat thread's conversation (thread work spec 1 to 5). It matches the rows'
// own text (find.ts), opens what holds the current match through the conversation's open state,
// and marks the matches with the CSS Custom Highlight API over the opened rows' text, never by
// rewriting the rendered markup. Where the API is missing, the current match's row is outlined.

// What the view asks of the bar: put the keyboard in its field (and select the text), or go to
// the next or previous match. `count` tells one request from the next.
export interface FindRequest {
  readonly kind: 'focus' | 'next' | 'previous';
  readonly count: number;
}

interface Registry {
  set(name: string, highlight: unknown): void;
  delete(name: string): void;
}
type HighlightConstructor = new (...ranges: Range[]) => unknown;

const highlightApi = (): { registry: Registry; Highlight: HighlightConstructor } | undefined => {
  const registry = (globalThis.CSS as { highlights?: Registry } | undefined)?.highlights;
  const Highlight = (globalThis as { Highlight?: HighlightConstructor }).Highlight;
  return registry && Highlight ? { registry, Highlight } : undefined;
};

// The row an item is drawn in: the innermost, since a group's row carries its first call's id.
const rowOf = (root: HTMLElement, itemId: string): HTMLElement | undefined =>
  [...root.querySelectorAll<HTMLElement>('li[data-item-id]')]
    .filter((row) => row.dataset['itemId'] === itemId)
    .at(-1);

// Where the needle shows in a row's own text: not in a row nested in it, and not in the words of
// its buttons, which find does not search.
function rangesIn(row: HTMLElement, needle: string): Range[] {
  const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const parent = node.parentElement;
    if (!parent || parent.closest('li[data-item-id]') !== row) continue;
    if (parent.closest('button:not([aria-expanded])')) continue;
    nodes.push(node as Text);
  }
  let text = '';
  const starts: number[] = [];
  for (const node of nodes) {
    starts.push(text.length);
    // In rendered Markdown, outside a <pre>, a line break shows as a space, as find reads a
    // message (find.ts); text written as is (a user's message, an output) keeps its lines.
    const parent = node.parentElement;
    const soft = parent?.closest('[data-testid="markdown"]') && !parent.closest('pre');
    const shown = soft ? softBreaks(node.data) : node.data;
    text += foldCase(shown);
  }
  const at = (offset: number, end: boolean): [Text, number] | undefined => {
    for (let index = nodes.length - 1; index >= 0; index -= 1) {
      const start = starts[index] ?? 0;
      const node = nodes[index];
      if (node && (end ? offset > start : offset >= start)) return [node, offset - start];
    }
    return undefined;
  };
  const ranges: Range[] = [];
  if (needle === '') return [];
  let from = text.indexOf(needle);
  while (from !== -1) {
    const start = at(from, false);
    const end = at(from + needle.length, true);
    if (start && end) {
      const range = document.createRange();
      range.setStart(...start);
      range.setEnd(...end);
      ranges.push(range);
    }
    from = text.indexOf(needle, from + needle.length);
  }
  return ranges;
}

export default function FindBar({
  source,
  root,
  store,
  query,
  onQuery,
  request,
  limit,
  onClose,
}: {
  source: FindSource;
  // The conversation's list, whose rows hold the text.
  root: RefObject<HTMLElement | null>;
  store: OpenStore;
  query: string;
  onQuery: (query: string) => void;
  request: FindRequest;
  // `chat.findMaxMatches`.
  limit: number;
  onClose: () => void;
}) {
  const field = useRef<HTMLInputElement>(null);
  const cache = useRef<MarkdownCache>(new Map());
  const pieces = useMemo(() => conversationText(source, cache.current), [source]);
  const result = useMemo(() => findMatches(pieces, query, limit), [pieces, query, limit]);
  const [current, setCurrent] = useState<Pick<FindMatch, 'itemId' | 'nth'>>();
  const index = keepCurrent(result.matches, current);
  const match = result.matches[index];
  // Set when the user moved to a match: the next paint scrolls it into view. A streaming turn
  // only repaints, so the view stays where the reader is.
  const scrollWanted = useRef(true);
  const opened = useRef<string>(undefined);
  const open = useStore(store, (state) => state.open);

  const move = (step: 1 | -1) => {
    const count = result.matches.length;
    if (count === 0) return;
    const next = result.matches[(((index + step) % count) + count) % count];
    if (!next) return;
    scrollWanted.current = true;
    opened.current = undefined;
    setCurrent({ itemId: next.itemId, nth: next.nth });
  };
  const moveRef = useRef(move);
  moveRef.current = move;

  useEffect(() => {
    if (request.kind === 'focus') {
      field.current?.focus();
      field.current?.select();
      return;
    }
    field.current?.focus();
    moveRef.current(request.kind === 'next' ? 1 : -1);
  }, [request.kind, request.count]);

  // A match inside something closed opens it, once, as a click would (spec 4).
  useEffect(() => {
    if (!match) return;
    const key = `${match.itemId}:${match.nth}`;
    if (opened.current === key) return;
    opened.current = key;
    openAll(store, pieces[match.piece]?.opens ?? []);
  }, [match, pieces, store]);

  const paintRef = useRef<() => void>(() => undefined);
  paintRef.current = () => {
    const list = root.current;
    if (!list) return;
    const needle = foldCase(query);
    const api = highlightApi();
    const all: Range[] = [];
    let currentRange: Range | undefined;
    const perRow = new Map<string, number>();
    for (const found of result.matches)
      perRow.set(found.itemId, (perRow.get(found.itemId) ?? 0) + 1);
    for (const [itemId, counted] of perRow) {
      const row = rowOf(list, itemId);
      if (!row) continue;
      const ranges = rangesIn(row, needle);
      all.push(...ranges);
      // The marks come from the row's text on screen, the count from the rows' words; where the
      // two disagree, a mark could stand on another occurrence than the one counted, so the
      // row is outlined instead.
      if (match?.itemId === itemId && ranges.length === counted) currentRange = ranges[match.nth];
    }
    const currentRow = match ? rowOf(list, match.itemId) : undefined;
    for (const marked of list.querySelectorAll<HTMLElement>('[data-find-current]')) {
      if (marked !== currentRow) {
        delete marked.dataset['findCurrent'];
        delete marked.dataset['findOutline'];
      }
    }
    if (currentRow) {
      currentRow.dataset['findCurrent'] = 'true';
      if (!api || !currentRange) currentRow.dataset['findOutline'] = 'true';
      else delete currentRow.dataset['findOutline'];
    }
    if (api) {
      api.registry.set('wow-find', new api.Highlight(...all));
      api.registry.set(
        'wow-find-current',
        new api.Highlight(...(currentRange ? [currentRange] : [])),
      );
    }
    if (scrollWanted.current && currentRow) {
      scrollWanted.current = false;
      const target = currentRange?.startContainer.parentElement ?? currentRow;
      target.scrollIntoView?.({ block: 'center' });
    }
  };

  // After every commit (rows opened, text streamed in) the marks follow the text on screen.
  useLayoutEffect(() => {
    paintRef.current();
  }, [result, index, open, query]);

  // Text that renders later (a lazily loaded part of a message) repaints too.
  useEffect(() => {
    const list = root.current;
    if (!list || typeof MutationObserver === 'undefined') return undefined;
    let frame: number | undefined;
    const observer = new MutationObserver(() => {
      if (frame !== undefined) return;
      frame = requestAnimationFrame(() => {
        frame = undefined;
        paintRef.current();
      });
    });
    observer.observe(list, { childList: true, subtree: true, characterData: true });
    return () => {
      observer.disconnect();
      if (frame !== undefined) cancelAnimationFrame(frame);
    };
  }, [root]);

  // Closing the bar takes the marks away; what it opened stays open (spec 4).
  useEffect(
    () => () => {
      const api = highlightApi();
      api?.registry.delete('wow-find');
      api?.registry.delete('wow-find-current');
      for (const marked of root.current?.querySelectorAll<HTMLElement>('[data-find-current]') ??
        []) {
        delete marked.dataset['findCurrent'];
        delete marked.dataset['findOutline'];
      }
    },
    [root],
  );

  const count = query === '' ? '' : findCountText(result, index, limit);
  return (
    <div
      role="search"
      aria-label="Find in conversation"
      data-testid="find-bar"
      onKeyDown={(event) => {
        if (event.key !== 'Escape') return;
        event.preventDefault();
        event.stopPropagation();
        onClose();
      }}
      className="flex shrink-0 items-center gap-1.5 border-b border-border px-4 py-1.5"
    >
      <SearchIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
      <Input
        ref={field}
        type="search"
        aria-label="Find in conversation"
        placeholder="Find in conversation"
        value={query}
        className="h-7 max-w-80 text-xs"
        onChange={(event) => {
          scrollWanted.current = true;
          opened.current = undefined;
          setCurrent(undefined);
          onQuery(event.target.value);
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            move(event.shiftKey ? -1 : 1);
          }
        }}
      />
      <span
        data-testid="find-count"
        aria-live="polite"
        className="min-w-16 text-xs text-muted-foreground tabular-nums"
      >
        {count}
      </span>
      <IconButton
        label="Previous match"
        shortcut="keybindings.findPrevious"
        disabled={result.matches.length === 0}
        onClick={() => move(-1)}
      >
        <ChevronUpIcon />
      </IconButton>
      <IconButton
        label="Next match"
        shortcut="keybindings.findNext"
        disabled={result.matches.length === 0}
        onClick={() => move(1)}
      >
        <ChevronDownIcon />
      </IconButton>
      <IconButton label="Close find" binding="Escape" onClick={onClose}>
        <XIcon />
      </IconButton>
    </div>
  );
}
