// The markdown body is a lazy chunk. Tests that render markdown load it first, so the first render
// does not wait on the import (a slow machine otherwise runs out of the query's time).
export const loadMarkdown = (): Promise<unknown> => import('../components/markdown-body');
