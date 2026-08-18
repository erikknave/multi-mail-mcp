import type { AllowedLogin, ApiKey, User } from '../db/repo.js';
import type { accountStatus } from '../service.js';

type AccountView = ReturnType<typeof accountStatus>;

/** Minimal HTML escaping for every interpolated value. */
export function esc(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const STYLES = `
:root {
  --bg: #f6f7f9; --panel: #ffffff; --ink: #16181d; --muted: #6b7280;
  --line: #e3e6ea; --accent: #2563eb; --ok: #15803d; --warn: #b45309; --err: #b91c1c;
  --radius: 10px;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #14161a; --panel: #1c1f25; --ink: #e8eaed; --muted: #9aa3ae;
    --line: #2c3138; --accent: #60a5fa; --ok: #4ade80; --warn: #fbbf24; --err: #f87171;
  }
}
* { box-sizing: border-box; }
body {
  margin: 0; background: var(--bg); color: var(--ink);
  font: 15px/1.55 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
}
.wrap { max-width: 880px; margin: 0 auto; padding: 32px 20px 64px; }
header.top {
  display: flex; align-items: baseline; justify-content: space-between;
  gap: 16px; flex-wrap: wrap; margin-bottom: 28px;
}
h1 { font-size: 22px; margin: 0; letter-spacing: -0.01em; }
h2 { font-size: 16px; margin: 0 0 12px; letter-spacing: -0.01em; }
.sub { color: var(--muted); font-size: 13px; margin: 4px 0 0; }
.card {
  background: var(--panel); border: 1px solid var(--line);
  border-radius: var(--radius); padding: 20px; margin-bottom: 20px;
}
.row {
  display: flex; align-items: center; justify-content: space-between;
  gap: 14px; padding: 12px 0; border-bottom: 1px solid var(--line); flex-wrap: wrap;
}
.row:last-child { border-bottom: 0; padding-bottom: 0; }
.row:first-of-type { padding-top: 0; }
.grow { flex: 1 1 260px; min-width: 0; }
.mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 13px; }
.muted { color: var(--muted); font-size: 13px; }
.pill {
  display: inline-block; padding: 2px 9px; border-radius: 999px;
  font-size: 12px; font-weight: 600; border: 1px solid currentColor;
}
.pill.ok { color: var(--ok); }
.pill.warn { color: var(--warn); }
.tag {
  display: inline-block; padding: 1px 7px; border-radius: 999px; font-size: 11px;
  font-weight: 600; color: var(--muted); border: 1px solid var(--line); vertical-align: 1px;
}
a { color: var(--accent); }
button, .btn {
  font: inherit; font-size: 14px; padding: 8px 14px; border-radius: 8px;
  border: 1px solid var(--line); background: var(--panel); color: var(--ink);
  cursor: pointer; text-decoration: none; display: inline-block; white-space: nowrap;
}
button:hover, .btn:hover { border-color: var(--accent); }
.btn.primary, button.primary {
  background: var(--accent); border-color: var(--accent); color: #fff; font-weight: 600;
}
.btn.danger, button.danger { color: var(--err); }
input[type=text], input[type=email] {
  font: inherit; padding: 8px 10px; border-radius: 8px;
  border: 1px solid var(--line); background: var(--bg); color: var(--ink); min-width: 240px;
}
.notice {
  padding: 12px 14px; border-radius: 8px; margin-bottom: 20px;
  border: 1px solid; font-size: 14px;
}
.notice.ok { color: var(--ok); }
.notice.err { color: var(--err); }
.notice.warn { color: var(--warn); }
pre {
  background: var(--bg); border: 1px solid var(--line); border-radius: 8px;
  padding: 12px; overflow-x: auto; font-size: 13px; margin: 8px 0 0;
}
code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
form.inline { display: inline; }
.empty { color: var(--muted); font-size: 14px; padding: 6px 0; }
.hero { text-align: center; padding: 56px 20px; }
.hero p { color: var(--muted); max-width: 46ch; margin: 12px auto 28px; }

/* Copyable blocks: the value plus a button pinned to its top-right corner. */
.copy { position: relative; }
.copy pre { margin: 8px 0 0; padding-right: 92px; }
.copy .copybtn { position: absolute; top: 14px; right: 8px; font-size: 12px; padding: 4px 10px; }
.copybtn.done { color: var(--ok); border-color: var(--ok); }
.keyvalue {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 15px; letter-spacing: 0.01em; word-break: break-all;
}
`;

/**
 * Clipboard copying, delegated from the document so it covers any number of
 * blocks. Copies the referenced element's textContent, so the value is never
 * duplicated into a JS string literal where it would need escaping.
 *
 * navigator.clipboard needs a secure context; the textarea fallback keeps the
 * button working if the page is ever opened over plain http.
 */
const COPY_SCRIPT = `
document.addEventListener('click', function (event) {
  var button = event.target.closest('[data-copy]');
  if (!button) return;

  var source = document.getElementById(button.getAttribute('data-copy'));
  if (!source) return;
  var value = source.textContent.trim();

  function done() {
    var original = button.textContent;
    button.textContent = 'Copied';
    button.classList.add('done');
    setTimeout(function () {
      button.textContent = original;
      button.classList.remove('done');
    }, 1600);
  }

  if (navigator.clipboard && window.isSecureContext) {
    navigator.clipboard.writeText(value).then(done, fallback);
  } else {
    fallback();
  }

  function fallback() {
    var area = document.createElement('textarea');
    area.value = value;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    try { document.execCommand('copy'); done(); } catch (err) { /* leave it selected */ }
    document.body.removeChild(area);
  }
});
`;

/** A <pre> block with a copy button wired to it. */
function copyBlock(id: string, content: string, label = 'Copy'): string {
  return `<div class="copy">
    <pre id="${esc(id)}"><code>${esc(content)}</code></pre>
    <button type="button" class="copybtn" data-copy="${esc(id)}">${esc(label)}</button>
  </div>`;
}

export function layout(title: string, body: string, user?: User | null): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>${STYLES}</style>
</head>
<body><div class="wrap">
<header class="top">
  <div>
    <h1><a href="/" style="text-decoration:none;color:inherit">multi-mail-mcp</a></h1>
    <p class="sub">Mail and calendar access for AI agents, across several Google and Microsoft accounts.</p>
  </div>
  ${
    user
      ? `<div style="text-align:right">
           <div class="mono">${esc(user.email)}</div>
           <div class="muted">
             ${user.is_admin ? '<a href="/admin">Admin</a> &middot; ' : ''}
             <a href="/logout">Sign out</a>
           </div>
         </div>`
      : ''
  }
</header>
${body}
</div>
<script>${COPY_SCRIPT}</script>
</body></html>`;
}

export function notice(kind: 'ok' | 'err' | 'warn', message: string): string {
  return `<div class="notice ${kind}">${esc(message)}</div>`;
}

export function landingPage(error?: string): string {
  return layout(
    'Sign in — multi-mail-mcp',
    `${error ? notice('err', error) : ''}
     <div class="card hero">
       <h2>Sign in with Google</h2>
       <p>
         There is no password. Sign in with any Google account that is allowed to use this
         service — that account is connected as your first mailbox automatically, and you can
         add more afterwards.
       </p>
       <a class="btn primary" href="/login">Sign in with Google</a>
     </div>`,
  );
}

export function dashboardPage(params: {
  user: User;
  accounts: AccountView[];
  keys: ApiKey[];
  newKey?: string;
  mcpUrl: string;
  /** False when the server has no Entra app registration, hiding the button. */
  microsoftAvailable: boolean;
  message?: { kind: 'ok' | 'err' | 'warn'; text: string };
}): string {
  const { user, accounts, keys, newKey, mcpUrl, microsoftAvailable, message } = params;

  const accountRows =
    accounts.length === 0
      ? `<p class="empty">No mailboxes connected yet.</p>`
      : accounts
          .map(
            (a) => `
      <div class="row">
        <div class="grow">
          <div class="mono">${esc(a.email)} <span class="tag">${esc(a.provider === 'microsoft' ? 'Microsoft' : 'Google')}</span></div>
          <div class="muted">
            ${a.displayName ? `${esc(a.displayName)} &middot; ` : ''}
            ${a.lastOkAt ? `last verified ${esc(a.lastOkAt.slice(0, 16).replace('T', ' '))} UTC` : 'never verified'}
            ${a.lastError ? `<br><span style="color:var(--err)">${esc(a.lastError)}</span>` : ''}
          </div>
        </div>
        <div>
          ${
            a.status === 'active'
              ? '<span class="pill ok">Active</span>'
              : '<span class="pill warn">Needs sign-in</span>'
          }
        </div>
        <div>
          ${
            a.reauthUrl
              ? `<a class="btn primary" href="${esc(a.reauthUrl)}">Renew access</a>`
              : `<a class="btn" href="/accounts/reauth?email=${encodeURIComponent(a.email)}">Renew</a>`
          }
          <form class="inline" method="post" action="/accounts/disconnect"
                onsubmit="return confirm('Disconnect ${esc(a.email)}? Agents will lose access to this mailbox.')">
            <input type="hidden" name="email" value="${esc(a.email)}">
            <button class="danger" type="submit">Disconnect</button>
          </form>
        </div>
      </div>`,
          )
          .join('');

  const keyRows =
    keys.length === 0
      ? `<p class="empty">No API keys yet. Create one to connect an MCP client.</p>`
      : keys
          .map(
            (k) => `
      <div class="row">
        <div class="grow">
          <div>${esc(k.name)}</div>
          <div class="muted mono">${esc(k.key_prefix)}&hellip; &middot;
            ${k.last_used_at ? `last used ${esc(new Date(k.last_used_at * 1000).toISOString().slice(0, 16).replace('T', ' '))} UTC` : 'never used'}
          </div>
        </div>
        <form class="inline" method="post" action="/keys/delete"
              onsubmit="return confirm('Revoke this key? Any client using it stops working immediately.')">
          <input type="hidden" name="id" value="${esc(k.id)}">
          <button class="danger" type="submit">Revoke</button>
        </form>
      </div>`,
          )
          .join('');

  // The full registration command, with the real key when one was just created.
  const mcpCommand = (key: string) =>
    `claude mcp add --transport http multi-mail ${mcpUrl} --header "Authorization: Bearer ${key}"`;

  return layout(
    'Dashboard — multi-mail-mcp',
    `${message ? notice(message.kind, message.text) : ''}
     ${
       newKey
         ? `<div class="card" style="border-color: var(--ok)">
              <h2 style="color: var(--ok)">Your new API key</h2>
              <p class="muted" style="margin-top:0">
                Copy it now — it is stored only as a hash, so this is the one time it is shown.
              </p>
              <div class="copy">
                <pre id="new-key"><code class="keyvalue">${esc(newKey)}</code></pre>
                <button type="button" class="copybtn primary" data-copy="new-key">Copy key</button>
              </div>
              <p class="muted" style="margin-bottom:4px">Or copy the whole registration command:</p>
              ${copyBlock('new-key-command', mcpCommand(newKey), 'Copy command')}
            </div>`
         : ''
     }

     <div class="card">
       <h2>Connected mailboxes</h2>
       ${accountRows}
       <div class="row">
         <div class="grow muted">
           Adding a mailbox grants this service read/write access to its mail and calendar.
           ${
             microsoftAvailable
               ? 'Google mailboxes additionally get Drive, Sheets and Docs; those tools are ' +
                 'not available for Microsoft mailboxes.'
               : ''
           }
         </div>
         <div>
           <a class="btn primary" href="/accounts/connect">Connect Google</a>
           ${
             microsoftAvailable
               ? '<a class="btn" href="/accounts/connect?provider=microsoft">Connect Microsoft</a>'
               : ''
           }
         </div>
       </div>
     </div>

     <div class="card">
       <h2>API keys</h2>
       ${keyRows}
       <div class="row">
         <form method="post" action="/keys" class="grow" style="display:flex;gap:8px;flex-wrap:wrap">
           <input type="text" name="name" placeholder="What is this key for? e.g. Claude Code" maxlength="60">
           <button class="primary" type="submit">Create key</button>
         </form>
       </div>
     </div>

     <div class="card">
       <h2>Connect an MCP client</h2>
       ${
         newKey
           ? `<p class="muted" style="margin-top:0">
                Run this to register the server with Claude Code — the key you just created is
                already filled in.
              </p>
              ${copyBlock('mcp-command', mcpCommand(newKey), 'Copy command')}`
           : `<p class="muted" style="margin-top:0">
                Create a key above and this command will be filled in with it. Existing keys
                cannot be shown again, so paste yours in place of <code>&lt;your-key&gt;</code>.
              </p>
              ${copyBlock('mcp-command', mcpCommand('<your-key>'), 'Copy command')}`
       }
       <p class="muted">
         Signed in as ${esc(user.email)}. An agent using your key can read, send and delete
         mail and calendar entries in every mailbox listed above.
       </p>
     </div>`,
    user,
  );
}

export function adminPage(params: {
  user: User;
  allowed: AllowedLogin[];
  users: User[];
  message?: { kind: 'ok' | 'err' | 'warn'; text: string };
}): string {
  const { user, allowed, users: allUsers, message } = params;

  const allowedRows =
    allowed.length === 0
      ? `<p class="empty">Nobody is on the allowlist.</p>`
      : allowed
          .map(
            (a) => `
      <div class="row">
        <div class="grow mono">${esc(a.email)}</div>
        <form class="inline" method="post" action="/admin/allowed/remove">
          <input type="hidden" name="email" value="${esc(a.email)}">
          <button class="danger" type="submit">Remove</button>
        </form>
      </div>`,
          )
          .join('');

  const userRows = allUsers
    .map(
      (u) => `
      <div class="row">
        <div class="grow">
          <div class="mono">${esc(u.email)}</div>
          <div class="muted">
            ${u.is_admin ? 'administrator &middot; ' : ''}
            ${u.last_login ? `last signed in ${esc(new Date(u.last_login * 1000).toISOString().slice(0, 10))}` : 'never signed in'}
          </div>
        </div>
      </div>`,
    )
    .join('');

  return layout(
    'Admin — multi-mail-mcp',
    `${message ? notice(message.kind, message.text) : ''}
     <div class="card">
       <h2>Who may sign in</h2>
       <p class="muted" style="margin-top:0">
         Only these addresses can create a new user. Someone signing in with an address that is
         already connected as a mailbox is logged into that mailbox's owner instead, so a person
         with several addresses ends up with one account, not several.
       </p>
       ${allowedRows}
       <div class="row">
         <form method="post" action="/admin/allowed" class="grow" style="display:flex;gap:8px;flex-wrap:wrap">
           <input type="email" name="email" placeholder="colleague@example.com" required>
           <button class="primary" type="submit">Allow</button>
         </form>
       </div>
     </div>

     <div class="card">
       <h2>Users</h2>
       ${userRows}
     </div>

     <p class="muted"><a href="/">&larr; Back to dashboard</a></p>`,
    user,
  );
}

export function messagePage(
  title: string,
  heading: string,
  body: string,
  kind: 'ok' | 'err' | 'warn' = 'ok',
): string {
  return layout(
    title,
    `<div class="card">
       <h2>${esc(heading)}</h2>
       ${notice(kind, body)}
       <a class="btn" href="/">Go to dashboard</a>
     </div>`,
  );
}
