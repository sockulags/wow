import type { BundledLanguage, BundledTheme, HighlighterGeneric } from 'shiki/bundle/web';
import { useEffect, useState } from 'react';
import { cn } from '@/lib/utils';

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
}: {
  readonly code: string;
  // A fence language such as "ts" or "bash"; empty or unknown shows plain text.
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
