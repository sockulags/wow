import type { ReactNode } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { CodeBlock } from './code-block';
import { FileLink, isFilePath, useFileLinks } from './file-links';
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
    const safe = safeHref(href);
    if (safe) {
      return (
        <a href={safe} target="_blank" rel="noreferrer" className="underline underline-offset-2">
          {children}
        </a>
      );
    }
    // A relative link in a chat message names a file of the thread (agent workbench spec 15).
    const target = href === undefined ? undefined : safeDecode(href);
    return files && target !== undefined && isFilePath(target) ? (
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
    const code = <code className="rounded bg-muted px-1 font-mono text-[0.9em]">{children}</code>;
    return files && typeof children === 'string' && isFilePath(children) ? (
      <FileLink path={children}>{code}</FileLink>
    ) : (
      code
    );
  },
  pre: ({ node, children }) => {
    const code = node?.children[0];
    if (code?.type !== 'element' || code.tagName !== 'code') return <pre>{children}</pre>;
    const classes = code.properties['className'];
    const language = Array.isArray(classes)
      ? (classes.map(String).find((name) => name.startsWith('language-')) ?? '').slice(9)
      : '';
    const text = code.children
      .map((child) => (child.type === 'text' ? child.value : ''))
      .join('')
      .replace(/\n$/, '');
    return language.toLowerCase() === 'mermaid' ? (
      <MermaidDiagram source={text} />
    ) : (
      <CodeBlock code={text} language={language} className="text-xs" />
    );
  },
};

// A link target as written: markdown encodes spaces and other characters in it.
function safeDecode(href: string): string | undefined {
  try {
    return decodeURI(href);
  } catch {
    return undefined;
  }
}

const plugins = [remarkGfm];
// Web and mail addresses stay; a relative path stays for the file link above; anything else
// (javascript:, file:) is dropped.
const urlTransform = (url: string) => safeHref(url) ?? (isFilePath(url) ? url : '');

export default function MarkdownBody({ text }: { readonly text: string }) {
  return (
    <ReactMarkdown remarkPlugins={plugins} components={components} urlTransform={urlTransform}>
      {text}
    </ReactMarkdown>
  );
}
