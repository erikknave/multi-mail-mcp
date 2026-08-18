import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { logger } from 'hono/logger';
import { config } from './config.js';
import { seedAllowedLogins } from './auth.js';
import { sessions, users } from './db/repo.js';
import { purgeExpiredUploads } from './service.js';
import { webRoutes } from './web/routes.js';
import { oauthRoutes } from './web/oauthRoutes.js';
import { fileRoutes } from './web/fileRoutes.js';
import { mcpRoutes } from './web/mcpRoutes.js';

seedAllowedLogins();

const app = new Hono();

// Keep the MCP endpoint out of the request log: tool traffic is high-volume and
// its bodies can contain mail contents.
app.use('*', async (c, next) => {
  if (c.req.path === '/mcp') return next();
  return logger()(c, next);
});

app.route('/', mcpRoutes);
app.route('/', oauthRoutes);
app.route('/', fileRoutes);
app.route('/', webRoutes);

app.notFound((c) => c.text('Not found', 404));

app.onError((err, c) => {
  console.error('[http] unhandled error', err);
  return c.text('Internal server error', 500);
});

/* Housekeeping: drop expired sessions and staged uploads once an hour. */
const HOUR = 60 * 60 * 1000;
const housekeeping = setInterval(() => {
  sessions.purgeExpired();
  void purgeExpiredUploads().catch((err) => console.error('[cleanup] upload purge failed', err));
}, HOUR);
housekeeping.unref();

const server = serve({ fetch: app.fetch, port: config.port, hostname: '0.0.0.0' }, (info) => {
  console.log(`multi-mail-mcp listening on http://localhost:${info.port}`);
  console.log(`  public base URL : ${config.publicBaseUrl}`);
  console.log(`  MCP endpoint    : ${config.publicBaseUrl}/mcp`);
  console.log(`  Google redirect : ${config.google.redirectUri}`);
  console.log(
    `  MS redirect     : ${config.microsoft?.redirectUri ?? '(Microsoft accounts not configured)'}`,
  );
  console.log(`  users registered: ${users.count()}`);
  if (users.count() === 0) {
    console.log(`\n  Open ${config.publicBaseUrl}/ and sign in with Google to get started.`);
    console.log(`  Allowed to sign in: ${config.allowedLoginEmails.join(', ') || '(nobody — set ALLOWED_LOGIN_EMAILS)'}`);
  }
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    console.log(`\nReceived ${signal}, shutting down.`);
    server.close(() => process.exit(0));
    // Don't hang forever on a stuck connection.
    setTimeout(() => process.exit(0), 5000).unref();
  });
}
