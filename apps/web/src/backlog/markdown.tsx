import { Markdown } from '@/components/markdown';
import { cn } from '@/lib/utils';

// Backlog bodies and publish previews go through the shared renderer (review loop spec 5).
export function MarkdownPreview({ markdown, className }: { markdown: string; className?: string }) {
  if (markdown.trim() === '') {
    return <p className={cn('text-sm text-muted-foreground', className)}>Nothing written yet.</p>;
  }
  return (
    <div data-testid="markdown-preview" className={className}>
      <Markdown text={markdown} />
    </div>
  );
}
