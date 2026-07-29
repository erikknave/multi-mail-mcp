import { Hono } from 'hono';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { authenticateApiKey } from '../auth.js';
import { config } from '../config.js';
import { buildMcpServer } from '../mcp/server.js';

export const mcpRoutes = new Hono();

/**
 * Stateless-per-request MCP endpoint.
 *
 * A fresh server and transport are built for every request and torn down after
 * it, so there is no cross-request session state to leak between users and no
 * cleanup to get wrong. Tool calls are short-lived request/response pairs, so
 * the per-request cost is negligible.
 */
mcpRoutes.all('/mcp', async (c) => {
  const user = authenticateApiKey(c.req.header('authorization'));

  if (!user) {
    return new Response(
      JSON.stringify({
        jsonrpc: '2.0',
        error: {
          code: -32001,
          message:
            'Unauthorized. Send an API key as "Authorization: Bearer <key>". ' +
            `Create one at ${config.publicBaseUrl}/`,
        },
        id: null,
      }),
      {
        status: 401,
        headers: {
          'content-type': 'application/json',
          'www-authenticate': 'Bearer realm="multi-mail-mcp"',
        },
      },
    );
  }

  const server = buildMcpServer(user);
  const transport = new WebStandardStreamableHTTPServerTransport({
    // Stateless: no session id, no server-side session state. Each request
    // carries its own bearer key, which is the only identity that matters, so
    // there is nothing a session would add — and a per-request transport in
    // stateful mode would reject every call after `initialize`.
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });

  try {
    await server.connect(transport);
    return await transport.handleRequest(c.req.raw);
  } catch (err) {
    console.error('[mcp] request failed', err);
    return new Response(
      JSON.stringify({
        jsonrpc: '2.0',
        error: { code: -32603, message: `Internal error: ${(err as Error).message}` },
        id: null,
      }),
      { status: 500, headers: { 'content-type': 'application/json' } },
    );
  }
});
