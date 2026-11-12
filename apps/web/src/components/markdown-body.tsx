import { useMemo, type ReactNode } from 'react';
import ReactMarkdown, { type Components, type Options } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { HostLinkRules } from '@wow/contracts';
import {
  HostChip,
  bareHostRefs,
  recogniseHostLink,
  recogniseHostRef,
  useHostLinks,
} from '@/chat/host-links';
import { FileTextIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useRowActions } from '@/lib/row-actions';
import { CodeBlock } from './code-block';
import { FileLink, filePathOf, isFilePath, useFileLinks } from './file-links';
import { safeHref } from './markdown';
import { MermaidDiagram } from './mermaid-diagram';

// The react-markdown part of `Markdown` (markdown.tsx), split out so the library loads on first
// use. Every element is ours: headings sit below the view's own, links are checked, fenced code
// goes to `CodeBlock` and `mermaid` fences to `MermaidDiagram`.

const headingTag = (level: number) => `h${Math.min(6, level + 2)}` as 'h3';
const headingClass = ['text-base', 'text-base', 'text-sm', 'text-sm', 'text-sm', 'text-sm'];

function heading(level: number) {
  const Tag = headingTag(level);
  return function Heading({ children }: { readonly children?: ReactNode }) {
    return (
      <Tag className={`font-semibold ${headingClass[level - 1] ?? 'text-sm'}`}>{children}</Tag>
    );
  };
}

const components: Components = {
  h1: heading(1),
  h2: heading(2),
  h3: heading(3),
  h4: heading(4),
  h5: heading(5),
  h6: heading(6),
  p: ({ children }) => <p className="whitespace-pre-wrap">{children}</p>,
  ul: ({ children }) => <ul className="flex list-disc flex-col gap-0.5 pl-5">{children}</ul>,
  ol: ({ children, start }) => (
    <ol start={start} className="flex list-decimal flex-col gap-0.5 pl-5">
      {children}
    </ol>
  ),
  li: ({ children }) => <li className="[&>ol]:mt-0.5 [&>ul]:mt-0.5">{children}</li>,
  blockquote: ({ children }) => (
    <blockquote className="flex flex-col gap-2 border-l-2 border-border pl-3 text-muted-foreground">
      {children}
    </blockquote>
  ),
  hr: () => <hr className="border-border" />,
  a: function Anchor({ href, children }) {
    const files = useFileLinks();
    const hosts = useHostLinks();
    // A bare reference the plugin below marked (agent workbench spec 24).
    if (href?.startsWith(bareRefScheme)) {
      const item = hosts && recogniseHostRef(href.slice(bareRefScheme.length), hosts.rules);
      return item && hosts ? <HostChip item={item} links={hosts} /> : <>{children}</>;
    }
    const safe = safeHref(href);
    // A link to an item on one of the thread's hosts is a chip (spec 20); any other stays a link.
    const item = safe && hosts ? recogniseHostLink(safe, hosts.rules) : undefined;
    if (item && hosts) return <HostChip item={item} links={hosts} />;
    if (safe) {
      return (
        <a href={safe} target="_blank" rel="noreferrer" className="underline underline-offset-2">
          {children}
        </a>
      );
    }
    // A relative link in a chat message names a file of the thread (agent workbench spec 15).
    const decoded = href === undefined ? undefined : safeDecode(href);
    const target = decoded === undefined ? undefined : filePathOf(decoded);
    return files && target !== undefined ? (
      <FileLink path={target}>{children}</FileLink>
    ) : (
      <span>{children}</span>
    );
  },
  // A picture would be fetched from wherever the message says; show its link instead.
  img: ({ src, alt }) => {
    const safe = safeHref(src);
    const label = alt === undefined || alt === '' ? (src ?? '') : alt;
    return safe ? (
      <a href={safe} target="_blank" rel="noreferrer" className="underline underline-offset-2">
        {label}
      </a>
    ) : (
      <span>{label}</span>
    );
  },
  table: ({ children }) => (
    <div className="overflow-x-auto">
      <table className="border-collapse text-left text-xs">{children}</table>
    </div>
  ),
  th: ({ children, style }) => (
    <th style={style} className="border border-border bg-muted/40 px-2 py-1 font-medium">
      {children}
    </th>
  ),
  td: ({ children, style }) => (
    <td style={style} className="border border-border px-2 py-1 align-top">
      {children}
    </td>
  ),
  code: function InlineCode({ children }) {
    const files = useFileLinks();
    const hosts = useHostLinks();
    const code = <code className="rounded bg-muted px-1 font-mono text-[0.9em]">{children}</code>;
    // `#3` or `!7` in code is code (a selector, a colour, a shell history line); a Jira key or an
    // address is still the item.
    const item =
      hosts && typeof children === 'string' && !/^\s*[#!]/.test(children)
        ? recogniseHostRef(children, hosts.rules)
        : undefined;
    if (item && hosts) return <HostChip item={item} links={hosts} />;
    const path = typeof children === 'string' ? filePathOf(children) : undefined;
    return files && path !== undefined ? <FileLink path={path}>{code}</FileLink> : code;
  },
  pre: function Pre({ node, children }) {
    const files = useFileLinks();
    const code = node?.children[0];
    if (code?.type !== 'element' || code.tagName !== 'code') return <pre>{children}</pre>;
    const classes = code.properties['className'];
    const fence = Array.isArray(classes)
      ? (classes.map(String).find((name) => name.startsWith('language-')) ?? '').slice(9)
      : '';
    const text = code.children
      .map((child) => (child.type === 'text' ? child.value : ''))
      .join('')
      .replace(/\n$/, '');
    if (fence.toLowerCase() === 'mermaid') return <MermaidDiagram source={text} />;
    const label = fenceLabel(fence, code.data?.meta ?? '');
    const block = <CodeBlock code={text} language={label.language} className="text-xs" copy />;
    if (!files || label.path === undefined) return block;
    const path = label.path;
    return (
      <LabelledCode path={path} onOpen={() => files.open(path)}>
        {block}
      </LabelledCode>
    );
  },
};

// A fence's label (agent workbench spec 32), as models write it: after the language
// (```ts src/timer.ts, ```js title="build.mjs"), joined to it (```ts:src/timer.ts) or as the
// language itself (```src/timer.ts). The language left over highlights the code.
function fenceLabel(fence: string, meta: string): { language: string; path?: string } {
  for (const word of meta.trim().split(/\s+/)) {
    const path = filePathOf(
      word.replace(/^(?:title|file|filename|path)=/i, '').replace(/^["']|["']$/g, ''),
    );
    if (path !== undefined) return { language: fence, path };
  }
  const colon = fence.indexOf(':');
  if (colon > 0) {
    const path = filePathOf(fence.slice(colon + 1));
    if (path !== undefined) return { language: fence.slice(0, colon), path };
  }
  const path = filePathOf(fence);
  if (path !== undefined) return { language: path.split('.').at(-1) ?? '', path };
  return { language: fence };
}

function LabelledCode({
  path,
  onOpen,
  children,
}: {
  readonly path: string;
  readonly onOpen: () => void;
  readonly children: ReactNode;
}) {
  const actions = useRowActions([
    { id: 'openFile', title: `Open file ${path}`, keywords: ['open', 'file', 'code'], run: onOpen },
  ]);
  return (
    <div className="space-y-1" {...actions}>
      <div className="flex items-center gap-2">
        <span className="min-w-0 truncate font-mono text-2xs text-muted-foreground">{path}</span>
        <Button
          type="button"
          size="xs"
          variant="outline"
          className="ml-auto"
          aria-label={`Open file ${path}`}
          onClick={onOpen}
        >
          <FileTextIcon aria-hidden />
          Open file
        </Button>
      </div>
      {children}
    </div>
  );
}

// A link target as written: markdown encodes spaces and other characters in it.
function safeDecode(href: string): string | undefined {
  try {
    return decodeURI(href);
  } catch {
    return undefined;
  }
}

// The address the plugin gives a bare reference's link, so the anchor above can tell it apart.
const bareRefScheme = 'wow-host-ref:';

interface MdNode {
  type: string;
  value?: string;
  url?: string;
  children?: MdNode[];
}

// Bare references in plain text (`DEMO-42`, `#14`, `!7`) become links the anchor above turns
// into chips; text inside links and code is left alone.
function bareRefs(rules: HostLinkRules) {
  const split = (node: MdNode): MdNode[] => {
    if (node.type !== 'text' || node.value === undefined) return [node];
    const value = node.value;
    const matches = bareHostRefs(value, rules);
    if (matches.length === 0) return [node];
    const parts: MdNode[] = [];
    let at = 0;
    for (const match of matches) {
      if (match.start > at) parts.push({ type: 'text', value: value.slice(at, match.start) });
      parts.push({
        type: 'link',
        url: `${bareRefScheme}${match.text}`,
        children: [{ type: 'text', value: match.text }],
      });
      at = match.end;
    }
    if (at < value.length) parts.push({ type: 'text', value: value.slice(at) });
    return parts;
  };
  const walk = (node: MdNode): void => {
    if (!node.children || node.type === 'link' || node.type === 'linkReference') return;
    node.children = node.children.flatMap(split);
    for (const child of node.children) walk(child);
  };
  return () => (tree: unknown) => walk(tree as MdNode);
}

// Web and mail addresses stay; a relative path stays for the file link above; a bare reference
// keeps its mark; anything else (javascript:, file:) is dropped.
const urlTransform = (url: string) =>
  url.startsWith(bareRefScheme) ? url : (safeHref(url) ?? (isFilePath(url) ? url : ''));

export default function MarkdownBody({ text }: { readonly text: string }) {
  const hosts = useHostLinks();
  const rules = hosts?.rules;
  const plugins = useMemo<NonNullable<Options['remarkPlugins']>>(
    () =>
      rules && (rules.repository !== null || rules.jiraKey !== null)
        ? [remarkGfm, bareRefs(rules)]
        : [remarkGfm],
    [rules],
  );
  return (
    <ReactMarkdown remarkPlugins={plugins} components={components} urlTransform={urlTransform}>
      {text}
    </ReactMarkdown>
  );
}
