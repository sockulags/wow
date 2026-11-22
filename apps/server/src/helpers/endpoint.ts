import type { ProviderToolset } from '@wow/contracts';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { answerMcp, bearerToken, unauthorized, type McpTools } from '../assistant/mcp.js';
import type { Logger } from '../logger.js';

// wow's helper tools for an ordinary chat session (agent orchestration spec 1, Interface): a
// second MCP path on the wow port. Each main thread gets its own token, made the first time its
// turn starts and kept in memory for the server's life, since a provider's session keeps the
// server address it was opened with across turns. A call is answered only for the thread its
// token was made for, and only while that thread may still have the tools.

export const helperMcpPath = '/threads/mcp';
export const helperToolsetName = 'wow';

// The helper tools of one thread. Until helpers exist (U2) there are none.
export interface HelperToolProvider {
  tools(threadId: string): McpTools;
}

const noTools: HelperToolProvider = {
  tools: () => ({
    list: () => [],
    call: (name) =>
      Promise.resolve({ text: JSON.stringify({ error: `No tool ${name}` }), isError: true }),
  }),
};

export interface HelperEndpointOptions {
  readonly version: string;
  readonly logger: Logger;
  // Whether the thread may have the helper tools now: a chat thread of the user's with
  // `chat.helpers` on. Asked on every call, so a thread that lost them is refused.
  readonly allowed: (threadId: string) => boolean;
  readonly provider?: HelperToolProvider | undefined;
}

export class HelperEndpoint {
  readonly #options: HelperEndpointOptions;
  readonly #tokens = new Map<string, string>();
  #url: string | undefined;

  constructor(options: HelperEndpointOptions) {
    this.#options = options;
  }

  // Once the server listens: http://127.0.0.1:<port>/threads/mcp
  listening(origin: string): void {
    this.#url = `${origin}${helperMcpPath}`;
  }

  // The toolset for the thread's turn; undefined before the server listens or when the thread may
  // not have the tools. The same token for every turn of the thread.
  grant(threadId: string): ProviderToolset | undefined {
    if (this.#url === undefined || !this.#options.allowed(threadId)) return undefined;
    let token = this.#tokens.get(threadId);
    if (token === undefined) {
      token = randomBytes(32).toString('base64url');
      this.#tokens.set(threadId, token);
    }
    return { name: helperToolsetName, url: this.#url, token };
  }

  // The thread the token was made for, compared in constant time.
  #threadOf(given: string): string | undefined {
    const candidate = Buffer.from(given);
    for (const [threadId, token] of this.#tokens) {
      const expected = Buffer.from(token);
      if (candidate.length === expected.length && timingSafeEqual(candidate, expected)) {
        return threadId;
      }
    }
    return undefined;
  }

  readonly handle = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const given = bearerToken(request);
    const threadId = given === null ? undefined : this.#threadOf(given);
    if (threadId === undefined || !this.#options.allowed(threadId)) {
      unauthorized(response);
      return;
    }
    const tools = (this.#options.provider ?? noTools).tools(threadId);
    await answerMcp(request, response, { ...this.#options, tools }, 'helper tools');
  };
}
