import { cutSessionPrompt, SessionId, type ProviderSession } from '@wow/contracts';
import { createReadStream } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { decodeClaudeProjectName } from './discover.js';

// "Open session from Claude Code / Codex…" (agent workbench spec 72): the sessions Claude Code
// keeps as `<config dir>/projects/<encoded cwd>/<session id>.jsonl`. The file name is the id
// `resume` takes. A session's first prompt is its first user line that is the user's own text:
// tool results, Claude Code's own notes (`isMeta`), subagent lines and the markup it writes for
// local commands are skipped, except that a slash command reads as the command and its
// arguments. Files are read line by line and closed at the first prompt; a file without one is
// read to its end.

export interface SessionListOptions {
  // The newest sessions kept, by the time their file last changed.
  readonly limit: number;
  // Characters of the first prompt kept; the rest is cut.
  readonly promptChars: number;
}

const tag = (text: string, name: string) =>
  new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(text)?.[1]?.trim();

// The tags Claude Code wraps its own user lines in. Other text that starts with "<" (a component
// name, pasted HTML) is the user's.
const ownTags = new Set([
  'command-name',
  'command-message',
  'command-args',
  'local-command-stdout',
  'local-command-stderr',
  'local-command-caveat',
  'system-reminder',
  'user-prompt-submit-hook',
  'bash-input',
  'bash-stdout',
  'bash-stderr',
  'task-notification',
]);

function promptText(text: string): string | undefined {
  const trimmed = text.trim();
  if (trimmed === '') return undefined;
  const opening = /^<([a-z][a-z-]*)>/.exec(trimmed)?.[1];
  if (opening === undefined || !ownTags.has(opening)) return trimmed;
  const command = tag(trimmed, 'command-name');
  if (command === undefined) return undefined;
  const args = tag(trimmed, 'command-args');
  return args ? `${command} ${args}` : command;
}

function userText(content: unknown): string | undefined {
  if (typeof content === 'string') return promptText(content);
  if (!Array.isArray(content)) return undefined;
  const texts = content.flatMap((block: unknown) =>
    block &&
    typeof block === 'object' &&
    'type' in block &&
    block.type === 'text' &&
    'text' in block &&
    typeof block.text === 'string'
      ? [block.text]
      : [],
  );
  return texts.length === 0 ? undefined : promptText(texts.join('\n'));
}

async function readSession(
  file: string,
): Promise<{ cwd: string | undefined; prompt: string | undefined }> {
  const lines = createInterface({ input: createReadStream(file, 'utf8'), crlfDelay: Infinity });
  let cwd: string | undefined;
  try {
    for await (const line of lines) {
      if (line.trim() === '') continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      if (!parsed || typeof parsed !== 'object') continue;
      if (cwd === undefined && 'cwd' in parsed && typeof parsed.cwd === 'string' && parsed.cwd)
        cwd = parsed.cwd;
      if (!('type' in parsed) || parsed.type !== 'user') continue;
      if ('isMeta' in parsed && parsed.isMeta === true) continue;
      if ('isSidechain' in parsed && parsed.isSidechain === true) continue;
      const message = 'message' in parsed ? parsed.message : undefined;
      const content =
        message && typeof message === 'object' && 'content' in message
          ? message.content
          : undefined;
      const prompt = userText(content);
      if (prompt !== undefined) return { cwd, prompt };
    }
    return { cwd, prompt: undefined };
  } finally {
    lines.close();
  }
}

export async function listClaudeSessions(
  configDir: string,
  options: SessionListOptions,
): Promise<ProviderSession[]> {
  const root = path.join(configDir, 'projects');
  const folders = await readdir(root, { withFileTypes: true }).catch(() => []);
  const files = (
    await Promise.all(
      folders
        .filter((entry) => entry.isDirectory())
        .map(async (entry) => {
          const dir = path.join(root, entry.name);
          const names = await readdir(dir).catch(() => []);
          return Promise.all(
            names
              // Older versions kept a subagent's transcript beside the session as agent-<id>.
              .filter((name) => name.endsWith('.jsonl') && !name.startsWith('agent-'))
              .map(async (name) => {
                const file = path.join(dir, name);
                const info = await stat(file).catch(() => undefined);
                return info?.isFile()
                  ? { file, folder: entry.name, id: name.slice(0, -'.jsonl'.length), info }
                  : undefined;
              }),
          );
        }),
    )
  )
    .flat()
    .filter((entry) => entry !== undefined)
    .toSorted((a, b) => b.info.mtime.getTime() - a.info.mtime.getTime())
    .slice(0, options.limit);
  const sessions = await Promise.all(
    files.map(async ({ file, folder, id, info }) => {
      const read = await readSession(file).catch(() => ({ cwd: undefined, prompt: undefined }));
      const cwd = read.cwd ?? decodeClaudeProjectName(folder);
      if (!cwd || !SessionId.safeParse(id).success) return undefined;
      return {
        id,
        cwd,
        firstPrompt:
          read.prompt === undefined ? null : cutSessionPrompt(read.prompt, options.promptChars),
        lastUsedAt: info.mtime.toISOString(),
      } satisfies ProviderSession;
    }),
  );
  return sessions.filter((session) => session !== undefined);
}
