# multi-mail-mcp

An MCP server that gives an AI agent access to **several Gmail / Google Workspace
accounts at once** — searching and reading mail, reading and updating calendars,
and downloading and uploading attachments.

Runs as a single Node process with a SQLite database and a small web UI.

---

## How it fits together

```
┌──────────────────────────────────────────────────────┐
│ multi-mail-mcp        (one process, port 8456)       │
│                                                      │
│   /mcp                    MCP endpoint (bearer key)  │
│   /                       web UI — mailboxes, keys   │
│   /oauth/google/callback  Google sign-in + consent   │
│   /reauth/<token>         one-click access renewal   │
│   /files/attachment/…     signed attachment download │
│   /files/upload/…         signed attachment upload   │
│                                                      │
│   SQLite: users, mailboxes, keys, staged uploads     │
└──────────────────────────────────────────────────────┘
                      │
                      └──► Gmail API + Calendar API, per mailbox
```

Mail is **not** mirrored locally. Every search goes straight to Gmail, so results
are always current and there is no index to maintain. Searching several mailboxes
runs the query against each in parallel and merges the results newest-first.

---

## Getting started

```bash
npm install
npm run build
npm start
```

Then open your `PUBLIC_BASE_URL` in a browser and **sign in with Google**.

1. **Sign in.** The account you sign in with is connected as your first mailbox
   automatically — one flow does both.
2. **Connect the other mailboxes** from the dashboard.
3. **Create an API key.** The dashboard then shows the key once, alongside a
   ready-to-run registration command with the key already filled in, and a copy
   button for each:

   ```bash
   claude mcp add --transport http multi-mail \
     https://your-host.example.com/mcp \
     --header "Authorization: Bearer <your-key>"
   ```

   Keys are 37 characters (`mmcp_` plus 192 bits of randomness) and are stored
   only as a SHA-256 hash, so a key that isn't copied at creation time is gone.

### Sign-in rules

There are no passwords. Google is the only way in, and which user you become
follows three rules, checked in order:

1. The address is a known user → sign in as them.
2. The address is already connected as a **mailbox** on some user → sign in as
   **that user**. This is what makes all of your addresses work as ways into one
   account instead of creating a separate user per address.
3. The address is on the allowlist (`ALLOWED_LOGIN_EMAILS`, then managed in the
   admin UI) → create a new user. The first user created becomes administrator.

Anything else is refused. The service is on a public URL, so this matters.

---

## Renewing Google access

Google expires refresh tokens after **7 days** while the OAuth app is in
*Testing* mode, so this will happen often at first. The whole flow is built
around making it a single click:

- Any tool call that hits a dead grant returns an **`ACTION REQUIRED`** message
  containing a ready-made link. The agent can hand that link straight to you.
- Multi-account operations (`search_messages`, `list_events`, `find_free_time`)
  don't fail outright when one mailbox is stale — they return results from the
  working mailboxes and list the broken ones with their renewal links.
- `list_accounts` always shows current status, and `get_reauth_url` produces a
  link on demand.
- Opening the link takes you straight to Google consent for that specific
  address. No prior sign-in needed; the link itself is the authorisation.

Links are HMAC-signed and valid for 24 hours. The callback refuses to proceed if
you sign in as a different Google account than the one the link was issued for.

**To stop the weekly expiry**, publish the OAuth app: Google Cloud Console →
*APIs & Services* → *OAuth consent screen* → **Publish app**. You will get an
"unverified app" warning screen once per consent (click *Advanced* → *Go to…*),
but refresh tokens then stop expiring. Full verification is only needed to go
past 100 users.

---

## Tools

**Accounts** — `list_accounts`, `check_account`, `get_reauth_url`

**Mail** — `search_messages`, `get_message`, `get_thread`, `list_labels`,
`modify_labels`, `send_message`, `create_draft`, `get_attachment_url`

**Calendar** — `list_calendars`, `list_events`, `get_event`, `create_event`,
`update_event`, `delete_event`, `respond_to_event`, `find_free_time`

**Attachments** — `create_upload_url`, `list_uploads`

Most tools take an optional `account` argument naming the mailbox. Omit it when
only one mailbox is connected; with several, the tool asks you to name one rather
than guessing — sending from the wrong address is not worth being clever about.

`search_messages` uses Gmail query syntax and returns compact summaries **without
bodies**, so a broad search doesn't flood the context window. Follow up with
`get_message` or `get_thread` for the text and the attachment list.

Search results deliberately carry no attachment flag: Gmail's `metadata` format
returns headers but not the MIME part tree, so any such field could only ever be
wrong. Filter with the `has:attachment` operator in the query instead — it runs
server-side and costs nothing.

### Attachments

**Downloading** — messages come back with a signed `downloadUrl` per attachment.
The URL streams from Gmail on demand; nothing is stored on the server. Valid for
one hour.

**Uploading** — `create_upload_url` reserves a slot and returns a URL to PUT to:

```bash
curl -X PUT --upload-file ./report.pdf "<uploadUrl>"
```

Then pass the returned `uploadId` in the `uploadIds` array of `send_message` or
`create_draft`. Staged files are deleted when the slot expires.

---

## Admin CLI

```bash
npm run cli -- allow <email>            # add to the sign-in allowlist
npm run cli -- users                    # list users
npm run cli -- accounts <user-email>    # mailboxes and their health
npm run cli -- key <user-email> [name]  # issue an API key
npm run cli -- keys <user-email>        # list keys
npm run cli -- audit [n]                # recent audit log
```

---

## Configuration

All settings live in `.env` (see `.env.example`). The ones that matter:

| Variable | Purpose |
|---|---|
| `PORT` | Listen port, e.g. `8456` behind a reverse proxy or tunnel. |
| `PUBLIC_BASE_URL` | Public origin. Used to build the OAuth redirect and every signed URL. |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | OAuth client, type *Web application*. |
| `ALLOWED_LOGIN_EMAILS` | Comma-separated addresses allowed to create a user. |
| `ENCRYPTION_KEY` | 32 random bytes, base64. Encrypts refresh tokens at rest. |
| `URL_SIGNING_SECRET` | 32 random bytes, base64. Signs download, upload and renewal links. |
| `MAX_UPLOAD_BYTES` | Attachment size cap, default 25 MB (Gmail's own ceiling). |

The redirect URI registered in Google Cloud Console must match
`<PUBLIC_BASE_URL>/oauth/google/callback` exactly.

**Rotating `ENCRYPTION_KEY` or `URL_SIGNING_SECRET` invalidates existing data**:
a new encryption key makes every stored refresh token unreadable, so every
mailbox has to be reconnected.

---

## Security notes

- **Google refresh tokens are encrypted at rest** with AES-256-GCM. Access tokens
  are cached encrypted too and refreshed a minute before expiry.
- **API keys are stored as SHA-256 hashes.** The plaintext is shown once, at
  creation, and is not recoverable.
- **Every tool is bound to the authenticated user.** A fresh MCP server is built
  per request with that user closed over, so no argument can reach another user's
  mailboxes.
- **Signed URLs are typed and time-limited.** A download token cannot be replayed
  as an upload token, and a tampered token fails HMAC verification.
- **Uploaded filenames never touch the filesystem path.** Files are stored under
  a random name; the display name lives only in the database.
- **`gmail.modify` is requested, not `gmail.full`** — an agent can archive, label
  and trash, but cannot permanently delete mail.
- Anyone holding an API key can read, send and delete mail in every connected
  mailbox. Treat keys as you would the mailbox passwords themselves, and revoke
  them from the dashboard when a client is retired.

---

## Running it as a service

Run it under systemd, not from a shell. A process started with `nohup ... &` is
a child of that shell's process group and dies with it — which looks exactly
like a crash, except the log ends with a clean `Received SIGTERM`.

A **user** service is enough; no root required:

```ini
# ~/.config/systemd/user/multi-mail-mcp.service
[Unit]
Description=multi-mail-mcp — Gmail/Calendar MCP server
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=/path/to/multi-mail-mcp
ExecStart=/usr/bin/node dist/index.js
Restart=always
RestartSec=5
# Give SQLite a moment to flush its WAL on stop.
TimeoutStopSec=15
SyslogIdentifier=multi-mail-mcp

[Install]
WantedBy=default.target
```

```bash
systemctl --user daemon-reload
systemctl --user enable --now multi-mail-mcp

# Required so the service keeps running when you log out, and starts at boot:
sudo loginctl enable-linger "$USER"
```

Day to day:

```bash
systemctl --user status multi-mail-mcp
systemctl --user restart multi-mail-mcp        # after a rebuild
journalctl --user -u multi-mail-mcp -f         # follow the log
```

`WorkingDirectory` is what lets the process find `.env` and `data/`, so it must
point at the checkout.

---

## Development

```bash
npm run dev        # watch mode
npm test           # unit tests
npm run typecheck  # types only
```

Tests cover the parts that are worth testing without live credentials: MIME
assembly, Gmail payload parsing, calendar mapping, token signing and expiry,
encryption round-trips, and filename sanitisation.
