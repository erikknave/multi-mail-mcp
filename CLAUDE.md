# Working on multi-mail-mcp

An MCP server giving agents access to several mailboxes at once, Google and
Microsoft side by side. `README.md` explains what it does and why; this file is
about working on it.

## This is a running service, not a checkout

It runs under systemd as the current user and serves a public URL. Two things
follow:

```bash
npm run build && systemctl --user restart multi-mail-mcp
journalctl --user -u multi-mail-mcp -f
```

- **The service runs `dist/`, not `src/`.** Restarting without building first
  means testing the previous version, which looks exactly like a fix that did
  not work.
- **Schema migrations run at startup** (`src/db/index.ts`). Back the database up
  before the first restart after a schema change — `data/` is gitignored, so
  `cp data/multi-mail.db data/backups/…` while the service is stopped.

## Verifying against a real mailbox

Unit tests cover the pure logic. Everything else — every Graph and Google API
shape — can only be confirmed against a live account, and this is how, without
minting an API key or speaking the MCP protocol:

```js
// node --input-type=module, with `set -a; . ./.env; set +a` first
const { accounts } = await import('./dist/db/repo.js');
const { mailApi, calendarApi, chatApi } = await import('./dist/service.js');
const { graphFor } = await import('./dist/microsoft/graph.js'); // raw Graph, for probing

const acc = accounts.byEmailAnyUser('erik@microsoft.dibbla.com');
const api = await mailApi(acc);
console.log(await api.searchMessages('is:unread', 5, false));
```

Every Graph bug in this codebase was found this way, usually by probing several
query shapes in a loop and seeing which the server actually accepts. Prefer it
to reasoning from the documentation: the docs did not predict any of the six
behaviours listed in README's "What differs from Google".

The MCP tool surface itself can be inspected without a client:

```js
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
// connect a Client to buildMcpServer(user) over a linked pair, then listTools()
```

**Do not exercise anything that sends** — mail, chat messages, calendar
invitations to real people — without asking first. Reading, drafting and
creating a chat are safe; a chat with no messages is invisible to the others.

## The provider rule

A capability is declared **once**, in `SCOPE_FOR` and `GRAPH_SCOPE_FOR` in
`src/config.ts`. A `null` means "this provider has no such thing". Everything
downstream derives from it: the `NOT AVAILABLE` refusal and its wording, the
`capabilities` list on `list_accounts`, which accounts a fan-out tool skips, and
which tools get registered at all.

So: **do not write per-provider `if` statements in the tools.** Tools talk to
`MailApi` / `CalendarApi` / `ChatApi` (`src/mail/types.ts`, `src/calendar/`,
`src/chat/`); `src/google/*` and `src/microsoft/*` implement them; `service.ts`
picks. A tool that names a provider is a design mistake somewhere below it.

Adding a capability means: the two scope maps, a label in `providers.ts`, the
interface, both implementations (or a `null`), a `service.ts` accessor, and a
registration branch in `mcp/server.ts`.

## Tool descriptions are the interface

They are what the model reads at the moment it decides. They are also the whole
context cost — measured at ~17k tokens for the full 60-tool surface, so a
paragraph is roughly 60 tokens charged on every request.

- Only tools a user's mailboxes can use are registered (`mcp/server.ts`). A tool
  that could only answer "not available" is not worth its context.
- Say the load-bearing thing, once. Repeating a caveat in four sibling tools was
  a real mistake made and then undone here.
- Never register a stub or planned tool.

## Conventions

- **Comments explain why, not what.** Most non-obvious lines here exist because
  a specific thing went wrong; the comment should say which, so nobody
  "simplifies" it back.
- **Never silently narrow a result.** Partial multi-account results carry
  `incomplete`; an untranslatable query fragment comes back in `queryNotes`; a
  calendar write that could not honour `sendUpdates` says so in `notes`. An
  empty answer must never be indistinguishable from "we could not look".
- **v1.0 Graph only.** A property that exists only in beta fails the entire
  request rather than being ignored. Confirm anything unfamiliar against a live
  mailbox before relying on it.
- **Never widen a scope for convenience.** `gmail.modify` and `Mail.ReadWrite`
  are chosen so an agent cannot permanently delete mail. Chat access is
  delegated, never application-wide.

## Commands

```bash
npm run typecheck   # tsc --noEmit
npm test            # ~100 unit tests, all in src/selftest.test.ts
npm run dev         # tsx watch, for work that does not need the live service
npm run cli -- accounts <user-email>   # mailboxes and their health
```
