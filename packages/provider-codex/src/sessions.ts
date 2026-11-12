import { cutSessionPrompt, SessionId, type ProviderSession } from '@wow/contracts';
import { createReadStream } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline';

// "Open session from Claude Code / Codex…" (agent workbench spec 72): the sessions Codex keeps
// as `<CODEX_HOME>/sessions/YYYY/MM/DD/rollout-<time>-<id>.jsonl`. The first line is the
// session's metadata (`session_meta`, with `id` and `cwd`; older versions put them at the top
// level). The first prompt is the first `user_message` event, else the first user message item
// that is not one of the notes Codex sends first (`codexNotes`).
// `thread/resume` takes the id. Files are read line by line and closed once the prompt is known;
// a file without one is read to its end.

export interface SessionListOptions {
  readonly limit: number;
  readonly promptChars: number;
}

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const text = (value: unknown) => (typeof value === 'string' && value !== '' ? value : undefined);

const isUserItem = (item: Record<string, unknown>) =>
  item['type'] === 'message' && item['role'] === 'user';

// The text of a user message item; undefined for one of the notes Codex sends ahead of it.
function messageText(item: Record<string, unknown>): string | undefined {
  const content = Array.isArray(item['content']) ? item['content'] : [];
  const texts = content.flatMap((part: unknown) =>
    record(part) && (part['type'] === 'input_text' || part['type'] === 'text')
      ? [text(part['text']) ?? '']
      : [],
  );
  const joined = texts.join('\n').trim();
  return joined === '' || codexNotes.some((note) => joined.startsWith(note)) ? undefined : joined;
}

// What Codex sends ahead of the user's first message. Other text that starts with "<" (a
// component name, pasted HTML) is the user's.
const codexNotes = [
  '<environment_context>',
  '<user_instructions>',
  '# AGENTS.md instructions',
  '<INSTRUCTIONS>',
];

// From the rollout's own name when the metadata has no id (`rollout-2026-11-01T08-00-00-<uuid>`).
const idFromName = (name: string) =>
  /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i.exec(name)?.[1];

async function readSession(file: string) {
  const lines = createInterface({ input: createReadStream(file, 'utf8'), crlfDelay: Infinity });
  let id: string | undefined;
  let cwd: string | undefined;
  let fallback: string | undefined;
  let noteAfterFallback = false;
  try {
    for await (const line of lines) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      if (!record(parsed)) continue;
      const payload = record(parsed['payload']) ? parsed['payload'] : parsed;
      if (parsed['type'] === 'session_meta' || (id === undefined && cwd === undefined)) {
        id ??= text(payload['id']);
        cwd ??= text(payload['cwd']);
      }
      if (parsed['type'] === 'event_msg' && payload['type'] === 'user_message') {
        const prompt = text(payload['message'])?.trim();
        if (prompt) return { id, cwd, prompt };
      }
      // Rollouts wrap items in `response_item`; older ones wrote them bare.
      const item =
        parsed['type'] === 'response_item'
          ? payload
          : parsed['payload'] === undefined
            ? parsed
            : {};
      if (isUserItem(item)) {
        const message = messageText(item);
        // A note Codex does not announce reads as the user's until one it does follows it.
        if (message === undefined) noteAfterFallback = fallback !== undefined;
        else if (fallback === undefined || noteAfterFallback) {
          fallback = message;
          noteAfterFallback = false;
        }
      } else if (typeof item['type'] === 'string' && fallback !== undefined && cwd !== undefined) {
        // Codex records the user_message event before the model answers; once an answer, a
        // reasoning item or a tool call follows, an older rollout without it has nothing better.
        return { id, cwd, prompt: fallback };
      }
    }
    return { id, cwd, prompt: fallback };
  } finally {
    lines.close();
  }
}

async function rollouts(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const nested = await Promise.all(
    entries.map((entry) => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) return rollouts(full);
      return Promise.resolve(entry.isFile() && entry.name.endsWith('.jsonl') ? [full] : []);
    }),
  );
  return nested.flat();
}

export async function listCodexSessions(
  codexHome: string,
  options: SessionListOptions,
): Promise<ProviderSession[]> {
  const files = await Promise.all(
    (await rollouts(path.join(codexHome, 'sessions'))).map(async (file) => {
      const info = await stat(file).catch(() => undefined);
      return info ? { file, modified: info.mtime } : undefined;
    }),
  );
  const newest = files
    .filter((entry) => entry !== undefined)
    .toSorted((a, b) => b.modified.getTime() - a.modified.getTime())
    .slice(0, options.limit);
  const sessions = await Promise.all(
    newest.map(async ({ file, modified }) => {
      const read = await readSession(file).catch(() => undefined);
      const id = read?.id ?? idFromName(path.basename(file));
      if (!read?.cwd || !id || !SessionId.safeParse(id).success) return undefined;
      return {
        id,
        cwd: read.cwd,
        firstPrompt:
          read.prompt === undefined ? null : cutSessionPrompt(read.prompt, options.promptChars),
        lastUsedAt: modified.toISOString(),
      } satisfies ProviderSession;
    }),
  );
  return sessions.filter((session) => session !== undefined);
}
