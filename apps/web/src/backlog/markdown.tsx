import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

// A small markdown preview for backlog bodies (audit D-12, D-08): headings, paragraphs, lists,
// quotes, rules, code blocks, and bold, italic, code and links inline. It builds React elements,
// never HTML strings, so a body cannot inject markup. Links open only for http(s) and mailto.

export type Block =
  | { readonly type: 'heading'; readonly level: number; readonly text: string }
  | { readonly type: 'paragraph'; readonly text: string }
  | { readonly type: 'list'; readonly ordered: boolean; readonly items: readonly ListItem[] }
  | { readonly type: 'quote'; readonly text: string }
  | { readonly type: 'code'; readonly language: string; readonly text: string }
  | { readonly type: 'rule' };

export interface ListItem {
  readonly text: string;
  readonly depth: number;
}

const fence = /^\s*(```|~~~)\s*([\w+-]*)\s*$/;
const heading = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const listItem = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
const rule = /^\s*([-*_])(\s*\1){2,}\s*$/;
const quote = /^\s*>\s?(.*)$/;

export function parseMarkdown(markdown: string): Block[] {
  const lines = markdown.replaceAll('\r\n', '\n').split('\n');
  const blocks: Block[] = [];
  let paragraph: string[] = [];
  const flush = () => {
    if (paragraph.length > 0) blocks.push({ type: 'paragraph', text: paragraph.join('\n') });
    paragraph = [];
  };
  let index = 0;
  while (index < lines.length) {
    const line = lines[index] ?? '';
    const opened = fence.exec(line);
    if (opened) {
      flush();
      const marker = opened[1] ?? '```';
      const body: string[] = [];
      index += 1;
      while (index < lines.length && !(lines[index] ?? '').trim().startsWith(marker)) {
        body.push(lines[index] ?? '');
        index += 1;
      }
      index += 1;
      blocks.push({ type: 'code', language: opened[2] ?? '', text: body.join('\n') });
      continue;
    }
    const item = listItem.exec(line);
    if (item) {
      flush();
      const ordered = /^\d/.test(item[2] ?? '');
      const items: ListItem[] = [];
      const indents: number[] = [];
      while (index < lines.length) {
        const current = listItem.exec(lines[index] ?? '');
        if (!current) break;
        const indent = (current[1] ?? '').replaceAll('\t', '  ').length;
        while (indents.length > 0 && indent < (indents.at(-1) ?? 0)) indents.pop();
        if (indents.length === 0 || indent > (indents.at(-1) ?? 0)) indents.push(indent);
        items.push({ text: current[3] ?? '', depth: indents.length - 1 });
        index += 1;
      }
      blocks.push({ type: 'list', ordered, items });
      continue;
    }
    index += 1;
    const titled = heading.exec(line);
    if (titled) {
      flush();
      blocks.push({ type: 'heading', level: titled[1]?.length ?? 1, text: titled[2] ?? '' });
    } else if (rule.test(line)) {
      flush();
      blocks.push({ type: 'rule' });
    } else if (quote.test(line)) {
      flush();
      blocks.push({ type: 'quote', text: quote.exec(line)?.[1] ?? '' });
    } else if (line.trim() === '') {
      flush();
    } else {
      paragraph.push(line);
    }
  }
  flush();
  return blocks;
}

const safeHref = (href: string) => (/^(https?:|mailto:)/i.test(href) ? href : undefined);

// Inline: `code`, **bold**, *italic* / _italic_, [text](url).
const inlinePattern =
  /(`[^`]+`)|(\*\*|__)(?=\S)(.+?)(?<=\S)\2|(\*|_)(?=\S)(.+?)(?<=\S)\4|\[([^\]]+)\]\(([^)\s]+)\)/;

export function renderInline(text: string, key = 'i'): ReactNode[] {
  const out: ReactNode[] = [];
  let rest = text;
  let count = 0;
  while (rest !== '') {
    const match = inlinePattern.exec(rest);
    if (!match) {
      out.push(rest);
      break;
    }
    if (match.index > 0) out.push(rest.slice(0, match.index));
    const id = `${key}-${count++}`;
    if (match[1]) {
      out.push(
        <code key={id} className="rounded bg-muted px-1 font-mono text-[0.9em]">
          {match[1].slice(1, -1)}
        </code>,
      );
    } else if (match[2]) {
      out.push(<strong key={id}>{renderInline(match[3] ?? '', id)}</strong>);
    } else if (match[4]) {
      out.push(<em key={id}>{renderInline(match[5] ?? '', id)}</em>);
    } else {
      const href = safeHref(match[7] ?? '');
      out.push(
        href ? (
          <a
            key={id}
            href={href}
            target="_blank"
            rel="noreferrer"
            className="underline underline-offset-2"
          >
            {renderInline(match[6] ?? '', id)}
          </a>
        ) : (
          <span key={id}>{match[6]}</span>
        ),
      );
    }
    rest = rest.slice(match.index + match[0].length);
  }
  return out;
}

const headingClass = ['text-base', 'text-base', 'text-sm', 'text-sm', 'text-sm', 'text-sm'];

export function MarkdownPreview({ markdown, className }: { markdown: string; className?: string }) {
  const blocks = parseMarkdown(markdown);
  if (blocks.length === 0) {
    return <p className={cn('text-sm text-muted-foreground', className)}>Nothing written yet.</p>;
  }
  return (
    <div data-testid="markdown-preview" className={cn('flex flex-col gap-2 text-sm', className)}>
      {blocks.map((block, index) => {
        const key = `b${index}`;
        switch (block.type) {
          case 'heading': {
            const Tag = `h${Math.min(6, block.level + 2)}` as 'h3';
            return (
              <Tag key={key} className={cn('font-semibold', headingClass[block.level - 1])}>
                {renderInline(block.text, key)}
              </Tag>
            );
          }
          case 'paragraph':
            return (
              <p key={key} className="whitespace-pre-wrap">
                {renderInline(block.text, key)}
              </p>
            );
          case 'list': {
            const Tag = block.ordered ? 'ol' : 'ul';
            return (
              <Tag
                key={key}
                className={cn(
                  'flex flex-col gap-0.5 pl-5',
                  block.ordered ? 'list-decimal' : 'list-disc',
                )}
              >
                {block.items.map((item, itemIndex) => (
                  <li key={`${key}-${itemIndex}`} style={{ marginLeft: `${item.depth * 1.25}rem` }}>
                    {renderInline(item.text, `${key}-${itemIndex}`)}
                  </li>
                ))}
              </Tag>
            );
          }
          case 'quote':
            return (
              <blockquote key={key} className="border-l-2 border-border pl-3 text-muted-foreground">
                {renderInline(block.text, key)}
              </blockquote>
            );
          case 'code':
            return (
              <pre
                key={key}
                className="overflow-x-auto rounded-md bg-muted p-2 font-mono text-xs whitespace-pre"
              >
                {block.text}
              </pre>
            );
          case 'rule':
            return <hr key={key} className="border-border" />;
        }
      })}
    </div>
  );
}
