import type { BundledLanguage, BundledTheme, HighlighterGeneric } from 'shiki/bundle/web';
import { useEffect, useState, type ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { useRowActions } from '@/lib/row-actions';
import { CopyButton, copyText } from './copy-button';

// Highlighted code (audit A-24) for chat code blocks, tool output and markdown previews. Shiki
// loads on first use, in its own chunk, with the JavaScript regex engine (no WebAssembly). Until it
// is ready, and for languages it does not know, the plain code shows in the same box.
//
//   <CodeBlock code={text} language="ts" />

type Highlighter = HighlighterGeneric<BundledLanguage, BundledTheme>;

let highlighter: Promise<{ shiki: Highlighter; known: ReadonlySet<string> }> | undefined;

function loadHighlighter(): Promise<{ shiki: Highlighter; known: ReadonlySet<string> }> {
  highlighter ??= (async () => {
    const [web, engine] = await Promise.all([
      import('shiki/bundle/web'),
      import('shiki/engine/javascript'),
    ]);
    const shiki = await web.createHighlighter({
      themes: ['github-light', 'github-dark'],
      langs: [],
      engine: engine.createJavaScriptRegexEngine(),
    });
    const known = new Set([
      ...Object.keys(web.bundledLanguages),
      ...Object.keys(web.bundledLanguagesAlias),
    ]);
    return { shiki, known };
  })();
  return highlighter;
}

// The highlighted HTML, or undefined for a language Shiki does not bundle. Shiki escapes the code.
export async function highlight(code: string, language: string): Promise<string | undefined> {
  const { shiki, known } = await loadHighlighter();
  const lang = language.toLowerCase();
  if (!known.has(lang)) return undefined;
  if (!shiki.getLoadedLanguages().includes(lang)) await shiki.loadLanguage(lang as BundledLanguage);
  return shiki.codeToHtml(code, {
    lang,
    themes: { light: 'github-light', dark: 'github-dark' },
    defaultColor: false,
  });
}

export function CodeBlock({
  code,
  language,
  className,
  copy = false,
}: {
  readonly code: string;
  // A fence language such as "ts" or "bash"; empty or unknown shows plain text.
  readonly language?: string | undefined;
  readonly className?: string | undefined;
  // A Copy button in the corner, shown on hover or focus (agent workbench spec 32).
  readonly copy?: boolean;
}) {
  const block = <HighlightedCode code={code} language={language} className={className} />;
  if (!copy) return block;
  return <CopyableCode code={code}>{block}</CopyableCode>;
}

function CopyableCode({ code, children }: { readonly code: string; readonly children: ReactNode }) {
  const actions = useRowActions([
    {
      id: 'copyCode',
      title: 'Copy code',
      keywords: ['copy', 'snippet', 'clipboard'],
      run: () => copyText(code),
    },
  ]);
  return (
    <div className="group/code relative" {...actions}>
      {children}
      <CopyButton
        text={code}
        label="Copy code"
        className="absolute top-1 right-1 bg-background/80 opacity-0 transition-opacity group-focus-within/code:opacity-100 group-hover/code:opacity-100 focus-visible:opacity-100"
      />
    </div>
  );
}

function HighlightedCode({
  code,
  language,
  className,
}: {
  readonly code: string;
  readonly language?: string | undefined;
  readonly className?: string | undefined;
}) {
  const [html, setHtml] = useState<{ for: string; html: string }>();
  const key = `${language ?? ''}\n${code}`;
  useEffect(() => {
    if (!language) return undefined;
    let live = true;
    highlight(code, language).then(
      (result) => live && result !== undefined && setHtml({ for: key, html: result }),
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [code, language, key]);
  const box = cn(
    'wow-code overflow-x-auto rounded-md border border-border bg-muted/40 p-3 font-mono text-xs',
    className,
  );
  if (html?.for === key) {
    // oxlint-disable-next-line react/no-danger -- Shiki escapes the code it wraps.
    return <div className={box} dangerouslySetInnerHTML={{ __html: html.html }} />;
  }
  return (
    <pre className={box}>
      <code>{code}</code>
    </pre>
  );
}
