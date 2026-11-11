import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Logger } from '../logger.js';
import type { AssistantTools } from './tools.js';

// The assistant's tools as one MCP server on the wow server's own port (app assistant spec,
// Decisions). It speaks MCP's Streamable HTTP transport without sessions: every request is
// answered on its own, in JSON. A request must carry the assistant's token, which is not the
// token the app's own connection uses; the token is checked before anything of the request is
// read.

export const assistantMcpPath = '/assistant/mcp';

export interface AssistantEndpoint {
  // http://127.0.0.1:<port>/assistant/mcp
  readonly url: string;
  // Sent as `Authorization: Bearer <token>`. Made at every server start and kept in memory only.
  readonly token: string;
  readonly tools: AssistantTools;
}

export interface McpHandlerOptions {
  readonly tools: AssistantTools;
  readonly token: string;
  readonly version: string;
  readonly logger: Logger;
}

function bearer(request: IncomingMessage): string | null {
  const header = request.headers.authorization;
  return header?.startsWith('Bearer ') ? header.slice('Bearer '.length) : null;
}

export function createMcpHandler(options: McpHandlerOptions) {
  const expected = Buffer.from(options.token);
  const allowed = (request: IncomingMessage): boolean => {
    const given = bearer(request);
    if (given === null) return false;
    const candidate = Buffer.from(given);
    return candidate.length === expected.length && timingSafeEqual(candidate, expected);
  };

  return async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    if (!allowed(request)) {
      response.writeHead(401, { 'content-type': 'text/plain', 'www-authenticate': 'Bearer' });
      response.end('Unauthorized');
      return;
    }
    const server = new Server(
      { name: 'wow', version: options.version },
      { capabilities: { tools: {} } },
    );
    server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: options.tools.list() }));
    server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
      const result = await options.tools.call(params.name, params.arguments);
      return { content: [{ type: 'text', text: result.text }], isError: result.isError };
    });
    // Without sessions the SDK wants a transport per request.
    const transport = new StreamableHTTPServerTransport({ enableJsonResponse: true });
    response.on('close', () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(request, response);
    } catch (error) {
      // The name only: a parse error's message can quote the request.
      options.logger.error(
        'assistant endpoint failed',
        error instanceof Error ? error.name : 'unknown error',
      );
      if (!response.headersSent) response.writeHead(500, { 'content-type': 'text/plain' });
      response.end();
    }
  };
}
