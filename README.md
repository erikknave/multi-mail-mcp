# multi-mail-mcp

An MCP server that gives an AI agent access to **several Gmail / Google Workspace
accounts at once** — searching and reading mail, reading and updating calendars,
reading and writing Google Drive, editing Sheets and Docs in place, and moving
attachments in and out.

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
`update_event`, `delete_event`, `respond_to_event`, `find_free_time`,
`find_rooms`

**Drive** — `search_drive`, `read_drive_file`, `list_drive_folder`,
`get_drive_download_url`, `upload_to_drive`, `write_drive_file`,
`create_drive_folder`, `update_drive_file`, `copy_drive_file`,
`trash_drive_file`, `restore_drive_file`, `get_drive_permissions`,
`share_drive_file`, `unshare_drive_file`, `get_drive_usage`

**Sheets** — `list_sheet_tabs`, `duplicate_sheet_tab`, `add_sheet_tab`,
`rename_sheet_tab`, `delete_sheet_tab`, `reorder_sheet_tab`, `read_sheet_range`,
`write_sheet_range`, `append_sheet_rows`, `clear_sheet_range`,
`format_sheet_range`, `auto_resize_sheet_columns`, `set_sheet_layout`,
`create_spreadsheet`

**Docs** — `read_doc`, `append_to_doc`, `append_doc_heading`, `replace_doc_text`,
`create_doc`

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

### Drive

Drive search uses **Drive query syntax**, which is not Gmail's:

```
name contains 'invoice' and mimeType = 'application/pdf'
fullText contains 'quarterly report'
modifiedTime > '2026-01-01T00:00:00'
'<folderId>' in parents
```

Three behaviours worth knowing:

- **Google Docs, Sheets and Slides hold no bytes.** They are exported on the
  way out — to Markdown, CSV and plain text when read as text, and to .docx,
  .xlsx and .pptx when downloaded. Asking for the "raw" content of a Doc is not
  a thing that exists.
- **Shared drives are included.** Every call opts in explicitly; without that
  the API quietly pretends team-drive content does not exist and a search
  returns a confident, wrong "no results".
- **Nothing is deleted permanently.** `trash_drive_file` bins the file, Drive
  keeps it 30 days, and `restore_drive_file` brings it back.

Sharing is deliberately limited: files can be shared with **named people only**.
The server cannot create "anyone with the link" access, because a mistakenly
public file is hard to notice afterwards. It *can* remove such a permission —
`get_drive_permissions` flags a publicly reachable file and `unshare_drive_file`
revokes it.

### Changing an existing invitation

A meeting room is an **attendee**, not the `location` field — it is booked by
adding its resource address, and `location` is free text that books nothing.
Events report their rooms separately (`rooms`) and flag each attendee with
`isResource` and a `displayName`, so a room is never just an opaque
`c_188…@resource.calendar.google.com`.

`update_event` merges guest changes rather than replacing them:

- `addAttendees` / `removeAttendees` change only the people you name. Everyone
  else keeps their RSVP, and any booked room stays booked.
- `setAttendees` replaces the whole list, uninviting anyone omitted — including
  rooms. It exists for when that is genuinely the intent.

The response says what actually changed, including when a room booking was
released or taken.

`find_rooms` lists the rooms you have used before, most frequent first, with the
address needed to book one. Enumerating every room in an organisation needs
Workspace admin rights, which this server does not have — but the rooms you have
already met in are the ones you want again.

For a repeating event, changes apply to the single occurrence unless you pass
`applyTo: "series"`.

### Sheets and Docs

**Never edit a spreadsheet or document through `write_drive_file`.** Drive treats
a file as one opaque blob, so writing to it replaces the whole thing — on a
workbook that destroys every other tab. Structured edits go through the Sheets
and Docs APIs instead:

- `write_sheet_range` writes cells and leaves the rest of the workbook alone.
- `duplicate_sheet_tab` copies a tab with its formatting, formulas, conditional
  formatting, column widths and frozen rows intact — the right way to start a
  new month from the last one. Clear the carried-over values with
  `clear_sheet_range`, which keeps the formatting.
- `append_to_doc` and `replace_doc_text` edit a document in place.

Both APIs are authorised by the **same Drive scope**, so enabling them needs no
new consent. They do need switching on once in the Cloud project:
[Sheets API](https://console.cloud.google.com/apis/library/sheets.googleapis.com) ·
[Docs API](https://console.cloud.google.com/apis/library/docs.googleapis.com).
Until then the tools say exactly that, with the link — they do not send anyone
through a pointless re-authentication.

Ranges use A1 notation (`'Jul 2026'!B2:F40`). A bare name such as `Jun 2026` or
`Sheet1` means the whole tab; `A1` means that cell.

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
  and trash, but cannot permanently delete mail. Drive follows the same line: the
  server never calls `files.delete`, only trash and restore.
- **Capabilities are checked before the call.** An account connected before a
  capability existed is detected from its stored scopes and told to extend its
  permission, rather than failing with an opaque 403 from inside the API.
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
