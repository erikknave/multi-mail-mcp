# multi-mail-mcp

An MCP server that gives an AI agent access to **several mailboxes at once** —
Gmail / Google Workspace and Microsoft 365 / Outlook side by side. Searching and
reading mail, reading and updating calendars, reading and writing Google Drive,
editing Sheets and Docs in place, and moving attachments in and out.

Mail and calendar work identically whichever service a mailbox is on: the same
Gmail query syntax, the same label names, the same recurrence rules. The rest is
whatever the provider actually has:

| | Google | Microsoft |
|---|:---:|:---:|
| Mail | ● | ● |
| Calendar | ● | ● |
| Drive, Sheets, Docs | ● | — |
| Teams chat | — | ● |
| Sign-in | ● | — |

Every account reports its own `capabilities` from `list_accounts`, and a tool
called against a provider that lacks the capability answers `NOT AVAILABLE`
rather than a permission error — because no consent screen would fix it.

Runs as a single Node process with a SQLite database and a small web UI.

---

## How it fits together

```
┌──────────────────────────────────────────────────────┐
│ multi-mail-mcp        (one process, port 8456)       │
│                                                      │
│   /mcp                       MCP endpoint (bearer key)     │
│   /                          web UI — mailboxes, keys      │
│   /oauth/google/callback     Google sign-in + consent      │
│   /oauth/microsoft/callback  Microsoft mailbox consent     │
│   /reauth/<token>            one-click access renewal      │
│   /files/attachment/…        signed attachment download    │
│   /files/upload/…            signed attachment upload      │
│                                                            │
│   SQLite: users, mailboxes, keys, staged uploads           │
└────────────────────────────────────────────────────────────┘
             │                              │
             ▼                              ▼
   Gmail / Calendar / Drive         Microsoft Graph
   (per Google mailbox)             (per Microsoft mailbox)
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
2. **Connect the other mailboxes** from the dashboard, Google or Microsoft.
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

There are no passwords, and **Google is the only way in** — a Microsoft account
can be connected as a mailbox but never used to sign in. That keeps one
authentication path to reason about, and one place where the allowlist applies.

Which user you become follows three rules, checked in order:

1. The address is a known user → sign in as them.
2. The address is already connected as a **mailbox** on some user → sign in as
   **that user**. This is what makes all of your addresses work as ways into one
   account instead of creating a separate user per address.
3. The address is on the allowlist (`ALLOWED_LOGIN_EMAILS`, then managed in the
   admin UI) → create a new user. The first user created becomes administrator.

Anything else is refused. The service is on a public URL, so this matters.

---

## Renewing access

Google expires refresh tokens after **7 days** while the OAuth app is in
*Testing* mode, so this will happen often at first. Microsoft's refresh tokens
roll forward as they are used and typically last months, so Microsoft mailboxes
rarely need this at all. The whole flow is built
around making it a single click:

- Any tool call that hits a dead grant returns an **`ACTION REQUIRED`** message
  containing a ready-made link. The agent can hand that link straight to you.
- Multi-account operations (`search_messages`, `list_events`, `find_free_time`)
  don't fail outright when one mailbox is stale — they return results from the
  working mailboxes and list the broken ones with their renewal links.
- `list_accounts` always shows current status, and `get_reauth_url` produces a
  link on demand.
- Opening the link takes you straight to the right provider's consent screen for
  that specific address — the link carries an account id, not a provider, so it
  works the same for both. No prior sign-in needed; the link itself is the
  authorisation.

Links are HMAC-signed and valid for 24 hours. The callback refuses to proceed if
you sign in as a different Google account than the one the link was issued for.

**To stop the weekly expiry**, publish the OAuth app: Google Cloud Console →
*APIs & Services* → *OAuth consent screen* → **Publish app**. You will get an
"unverified app" warning screen once per consent (click *Advanced* → *Go to…*),
but refresh tokens then stop expiring. Full verification is only needed to go
past 100 users.

---

## Connecting Microsoft mailboxes

Microsoft support is optional and switches itself on once an app registration is
configured. Without `MICROSOFT_CLIENT_ID` the dashboard simply does not offer it.

In **Azure Portal → Microsoft Entra ID → App registrations → New registration**:

1. **Supported account types** — *Accounts in any organizational directory
   (multitenant)* to allow any work or school tenant. Use a single tenant id in
   `MICROSOFT_AUTHORITY` to restrict it to your own, or `common` to also allow
   personal outlook.com accounts.
2. **Redirect URI** — type *Web*, exactly
   `<PUBLIC_BASE_URL>/oauth/microsoft/callback`.
3. **Certificates & secrets → New client secret** — copy the *Value*, not the
   Secret ID. It is shown once, and it expires; note the date.
4. **API permissions → Microsoft Graph → Delegated**: `offline_access`, `openid`,
   `email`, `profile`, `User.Read`, `Mail.ReadWrite`, `Mail.Send`,
   `Calendars.ReadWrite`, `Chat.ReadWrite`, `Chat.Create`. Then
   **Grant admin consent** —
   depending on the tenant's settings an ordinary user may not be able to
   consent alone.

`Mail.ReadWrite` is deliberate in the same way `gmail.modify` is: it covers
reading, moving, flagging and drafting, but not permanent deletion. `Mail.Send`
is separate so sending is its own explicit grant. `Chat.ReadWrite` authorises
reading and posting in the chats the user belongs to, and `Chat.Create` starting
new ones — `ChatMessage.Send` would add nothing, and the *application* chat
permissions, which are gated and metered by Microsoft, are not used at all.

### What differs from Google

Everything below is handled by the server; this is what is happening underneath.

| Gmail idea | Outlook equivalent |
|---|---|
| Labels | Folder, plus read/flagged state and categories |
| `INBOX` / `SENT` / `DRAFT` / `TRASH` / `SPAM` / `ARCHIVE` | The matching well-known folders |
| Archive (remove `INBOX`) | Move to Archive |
| `UNREAD`, `STARRED` | `isRead`, flag status |
| A user label | A folder move, or a category |
| Thread id | Conversation id |
| Query syntax | Translated to KQL or an OData filter |
| RRULE recurrence | Translated to an Outlook recurrence pattern |
| Google Meet | Teams meeting |

Five honest limits:

- **`bcc:` cannot be searched.** Outlook does not index it. A query using it
  comes back with a `queryNotes` entry saying so, rather than quietly returning
  results that ignored the term.
- **`sendUpdates` is not honoured.** Outlook always notifies attendees; a
  calendar write that asked for silence says so in `notes`.
- **`find_free_time` takes addresses, not calendar ids.** Graph's free/busy is
  per mailbox — `"primary"` means the account's own address, and any colleague
  or room address can be added.
- **Drive, Sheets and Docs are Google-only.** Called against a Microsoft mailbox
  they answer `NOT AVAILABLE`, which is not a permission problem and cannot be
  fixed by re-authenticating.
- **Moving a message changes its id.** Outlook reissues a message under a new
  id when it changes folder, so `modify_labels` returns the id to use from now
  on — with `previousMessageId` and a note when it moved. Gmail ids are
  unaffected by labelling and come back unchanged.
- **`list_events` spans at most five years per call.** Outlook caps an expanded
  calendar view at 1825 days; Google has none. Asking wider is refused with the
  limit named, rather than passed through as Graph's "greater than the allowed
  range", which reads like a quota.

Two notes on ordering, both learned the hard way against a live mailbox:

- When a query needs full-text matching, Graph's `$search` forbids `$orderby`,
  so the server fetches a wider page and sorts by date itself. Queries built
  only from filterable terms (`is:unread`, date ranges, `has:attachment`) take
  the exact, server-ordered path instead.
- On that filtered path, Exchange rejects `$orderby=receivedDateTime` unless the
  filter *leads* with `receivedDateTime` — `is:starred` and
  `is:unread has:attachment` both failed with "The restriction or sort order is
  too complex for this operation" until an open-ended lower bound was prepended.
  Dropping `$orderby` instead would have been worse: the server would then be
  free to return any N matches, quietly turning "the 20 newest unread" into "20
  unread, in some order".

Three more Graph behaviours worth not rediscovering:

- `mailFolder.wellKnownName` exists in the Graph **beta** endpoint but not in
  v1.0, and naming an unknown property in `$select` fails the entire request
  rather than returning null for it. The well-known folders are resolved by
  name through a single `$batch` instead.
- **A write response ignores the `Prefer: outlook.timezone` header.** A created
  or patched event comes back in the zone it was submitted in, while reads come
  back in UTC as asked. Stamping that wall clock with `Z` reported a 09:00
  Stockholm meeting as 09:00Z — two hours out, in a value an agent would repeat
  to a human as fact. Times are now converted from whatever zone the response
  declares, IANA or the Windows names some tenants still use.
- **Junk and Deleted Items are excluded in the query, not from the results.**
  Graph searches every folder by default while Gmail does not, and dropping the
  unwanted ones after fetching `$top=N` lets deleted mail eat the result slots —
  a one-result search returned nothing at all when the newest message happened
  to be in the bin, which reads as "no mail" rather than "the newest is
  deleted". `parentFolderId ne` does it server-side. The `$search` path cannot
  combine with `$filter`, so it still sifts afterwards and over-fetches to
  compensate.
- **A sent message is not in Sent Items immediately.** A lookup fired the moment
  `/send` returns finds nothing, so `send_message` retries once and then reports
  `messageId: null` with a note to find it through `get_thread` — rather than an
  empty string the caller would pass to `get_message`.

### Teams chat

`list_chats`, `read_chat`, `start_chat` and `send_chat_message` cover the chats
the connected account itself belongs to — one-to-one, group and meeting chats —
including **federated** ones where someone from another organisation is writing
to you.

Creating and sending are separate tools, which is not an accident: a chat with no
messages in it is invisible to the other people, so `start_chat` notifies nobody
and only `send_chat_message` is outward-facing. Teams allows one one-to-one chat
per pair, so asking for one that exists returns the existing conversation with
its history and says `alreadyExisted` — group chats have no such rule, and
calling twice really does create two.

Two things it deliberately does not do:

- **Guest chats in another tenant.** If you were invited as a guest and switch
  organisation in the Teams client, those conversations belong to *that* tenant,
  and an access token is always for exactly one tenant. Reaching them means
  connecting that tenant as its own account, with its own consent.
- **Downloading chat attachments.** Files posted in a chat live in the sender's
  OneDrive or a SharePoint site, and the server holds no file permissions for
  Microsoft accounts. Attachments come back as a name and a link to hand to the
  user.

Everyone in a chat is checked against the connected account's own tenant, and
anyone outside it is flagged — as is anyone whose tenant cannot be determined,
plus bots and anonymous meeting participants. The flag errs towards "external"
on purpose: mistaking a colleague for an outsider costs one extra question,
while mistaking an outsider for a colleague means replying to them without
asking at all. `read_chat` names who triggered the flag so it can be checked
rather than taken on trust.

Sending is immediate and has no draft state and no unsend, which the tool
description says plainly so an agent confirms the wording first.

---

## Tools

Mail, calendar and account tools work with both providers. Drive, Sheets and Docs
are Google-only; Teams chat is Microsoft-only.

**Only the tools your mailboxes can use are registered.** A tool that could
only ever answer "not available for this account" is not worth the context it
costs to describe, and a shorter list is one a model chooses from more
accurately. So the Drive, Sheets and Docs tools appear once a Google mailbox is
connected, the Teams chat tools once a Microsoft one is, and a user with nothing
connected sees only the three account tools — which is what tells them to
connect a mailbox. In tokens, the full surface is around 17k; a Microsoft-only
user sees about 8.7k, and a user with no mailboxes about 0.8k.

The endpoint is stateless, so the list is recomputed on every request and needs
no cache invalidating. A client that caches `tools/list` may need to reconnect
before newly connected mailboxes bring their tools into view.

**Accounts** — `list_accounts`, `check_account`, `get_reauth_url`

**Mail** — `search_messages`, `get_message`, `get_thread`, `list_labels`,
`modify_labels`, `send_message`, `create_draft`, `get_attachment_url`

**Calendar** — `list_calendars`, `list_events`, `get_event`, `create_event`,
`update_event`, `delete_event`, `respond_to_event`, `find_free_time`,
`find_rooms`

**Teams chat** (Microsoft only) — `list_chats`, `read_chat`, `start_chat`,
`send_chat_message`

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

`search_messages` uses Gmail query syntax — against both providers — and returns
compact summaries **without bodies**, so a broad search doesn't flood the context
window. Follow up with `get_message` or `get_thread` for the text and the
attachment list.

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
| `MICROSOFT_CLIENT_ID` / `MICROSOFT_CLIENT_SECRET` | Entra ID app registration. Blank disables Microsoft mailboxes. |
| `MICROSOFT_AUTHORITY` | `organizations` (default), a tenant id, or `common` to allow personal accounts. |
| `ALLOWED_LOGIN_EMAILS` | Comma-separated addresses allowed to create a user. |
| `ENCRYPTION_KEY` | 32 random bytes, base64. Encrypts refresh tokens at rest. |
| `URL_SIGNING_SECRET` | 32 random bytes, base64. Signs download, upload and renewal links. |
| `MAX_UPLOAD_BYTES` | Attachment size cap, default 25 MB (Gmail's own ceiling). |

The redirect URIs must match exactly: `<PUBLIC_BASE_URL>/oauth/google/callback`
in Google Cloud Console, and `<PUBLIC_BASE_URL>/oauth/microsoft/callback` in
Entra ID.

**Rotating `ENCRYPTION_KEY` or `URL_SIGNING_SECRET` invalidates existing data**:
a new encryption key makes every stored refresh token unreadable, so every
mailbox has to be reconnected.

---

## Security notes

- **Refresh tokens are encrypted at rest** with AES-256-GCM, for both providers.
  Access tokens are cached encrypted too and refreshed ahead of expiry. Microsoft
  rotates its refresh token on every renewal, and the new one is persisted — the
  grant would otherwise die at the following renewal.
- **The two OAuth flows cannot be crossed.** Each callback signs its state with a
  distinct kind, so an authorization code obtained for one provider cannot be
  replayed at the other's callback.
- **Microsoft is not a sign-in method.** Its callback has no path that creates a
  user; it requires an established session or a signed renewal link.
- **API keys are stored as SHA-256 hashes.** The plaintext is shown once, at
  creation, and is not recoverable.
- **Every tool is bound to the authenticated user.** A fresh MCP server is built
  per request with that user closed over, so no argument can reach another user's
  mailboxes.
- **Signed URLs are typed and time-limited.** A download token cannot be replayed
  as an upload token, and a tampered token fails HMAC verification.
- **Uploaded filenames never touch the filesystem path.** Files are stored under
  a random name; the display name lives only in the database.
- **Chat access is delegated, never application-wide.** `Chat.ReadWrite` reaches
  only the chats the signed-in user is already in — there is no path to reading
  the organisation's messages, and the gated application permissions that would
  allow it are not requested.
- **`gmail.modify` is requested, not `gmail.full`**, and `Mail.ReadWrite` rather
  than anything wider — an agent can archive, label and trash, but cannot
  permanently delete mail. Drive follows the same line: the server never calls
  `files.delete`, only trash and restore.
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
Description=multi-mail-mcp — mail and calendar MCP server
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
assembly, Gmail payload parsing, calendar mapping for both providers, the
Gmail→Graph query translation, RRULE conversion, capability checks, chat
participant and message mapping (through a stubbed Graph), HTML entity decoding,
token signing and expiry, encryption round-trips, and filename sanitisation.

The provider split lives in three places: `src/mail/types.ts`,
`src/calendar/types.ts` and `src/chat/types.ts` define what a mailbox must be
able to do, `src/google/*` and `src/microsoft/*` implement it, and
`src/service.ts` picks between them. Tools never see a provider-specific client.

Which provider offers what is stated once, in `SCOPE_FOR` and `GRAPH_SCOPE_FOR`
in `src/config.ts`. A `null` there means "this provider has no such thing", and
everything downstream — the refusal message, the `capabilities` list, which
accounts a fan-out tool skips — follows from it.
