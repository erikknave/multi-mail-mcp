/**
 * Unit tests for the pure logic — MIME assembly, token signing, payload parsing,
 * query translation and filename handling. Anything that talks to Google or
 * Microsoft is verified by hand against a live account instead, since it needs
 * real credentials.
 *
 * Run with: npm test
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';

process.env.PUBLIC_BASE_URL ??= 'https://example.test';
process.env.GOOGLE_CLIENT_ID ??= 'test-client-id';
process.env.GOOGLE_CLIENT_SECRET ??= 'test-client-secret';
process.env.ENCRYPTION_KEY ??= Buffer.alloc(32, 1).toString('base64');
process.env.URL_SIGNING_SECRET ??= Buffer.alloc(32, 2).toString('base64');
process.env.DATA_DIR ??= './data/test';

const { encrypt, decrypt, signToken, verifyToken, generateApiKey, hashApiKey, safeEqual } =
  await import('./crypto.js');
const { buildMimeMessage, parseMessage, summarize } = await import('./google/gmail.js');
const { toEventSummary } = await import('./google/calendar.js');
const { safeFilename } = await import('./service.js');

/* ------------------------------------------------------------------ *
 * Encryption
 * ------------------------------------------------------------------ */

test('encrypt round-trips and produces different ciphertext each time', () => {
  const secret = 'a-google-refresh-token-1//abcdef';
  const a = encrypt(secret);
  const b = encrypt(secret);
  assert.notEqual(a, b, 'IV must differ between encryptions');
  assert.equal(decrypt(a), secret);
  assert.equal(decrypt(b), secret);
});

test('decrypt rejects a tampered ciphertext', () => {
  const payload = encrypt('sensitive');
  const parts = payload.split('.');
  // Flip a byte in the ciphertext segment.
  const ct = Buffer.from(parts[3]!, 'base64url');
  ct[0] = ct[0]! ^ 0xff;
  const tampered = [parts[0], parts[1], parts[2], ct.toString('base64url')].join('.');
  assert.throws(() => decrypt(tampered));
});

/* ------------------------------------------------------------------ *
 * Signed tokens
 * ------------------------------------------------------------------ */

test('signed token round-trips and carries its payload', () => {
  const token = signToken({ k: 'dl', exp: Math.floor(Date.now() / 1000) + 60, mid: 'm1' });
  const parsed = verifyToken(token, 'dl');
  assert.ok(parsed);
  assert.equal(parsed.mid, 'm1');
});

test('token of the wrong kind is rejected', () => {
  const token = signToken({ k: 'dl', exp: Math.floor(Date.now() / 1000) + 60 });
  assert.equal(verifyToken(token, 'ul'), null, 'a download token must not pass as an upload token');
});

test('expired token is rejected', () => {
  const token = signToken({ k: 'dl', exp: Math.floor(Date.now() / 1000) - 1 });
  assert.equal(verifyToken(token, 'dl'), null);
});

test('token with a forged signature is rejected', () => {
  const token = signToken({ k: 'dl', exp: Math.floor(Date.now() / 1000) + 60, mid: 'm1' });
  const [body] = token.split('.');
  const forged = `${body}.${Buffer.from('not-the-real-mac').toString('base64url')}`;
  assert.equal(verifyToken(forged, 'dl'), null);
});

test('token with an edited payload is rejected', () => {
  const token = signToken({ k: 'dl', exp: Math.floor(Date.now() / 1000) + 60, mid: 'm1' });
  const [, mac] = token.split('.');
  const swapped = Buffer.from(
    JSON.stringify({ k: 'dl', exp: Math.floor(Date.now() / 1000) + 60, mid: 'SOMEONE-ELSES' }),
  ).toString('base64url');
  assert.equal(verifyToken(`${swapped}.${mac}`, 'dl'), null);
});

/* ------------------------------------------------------------------ *
 * API keys
 * ------------------------------------------------------------------ */

test('generated API keys are unique and hash consistently', () => {
  const a = generateApiKey();
  const b = generateApiKey();
  assert.notEqual(a.key, b.key);
  assert.equal(a.hash, hashApiKey(a.key));
  assert.notEqual(a.hash, b.hash);
  assert.ok(a.key.startsWith('mmcp_'));
  assert.ok(a.key.startsWith(a.prefix));
});

test('safeEqual compares without throwing on length mismatch', () => {
  assert.equal(safeEqual('abc', 'abc'), true);
  assert.equal(safeEqual('abc', 'abd'), false);
  assert.equal(safeEqual('abc', 'abcd'), false);
});

/* ------------------------------------------------------------------ *
 * Filenames
 * ------------------------------------------------------------------ */

test('safeFilename strips directory traversal', () => {
  assert.equal(safeFilename('../../etc/passwd'), 'passwd');
  assert.equal(safeFilename('/absolute/path/report.pdf'), 'report.pdf');
  assert.equal(safeFilename('C:\\Windows\\evil.exe'), 'evil.exe');
  assert.equal(safeFilename('..'), 'file');
  assert.equal(safeFilename(''), 'file');
});

test('safeFilename keeps ordinary names including non-ASCII', () => {
  assert.equal(safeFilename('Årsredovisning 2026.pdf'), 'Årsredovisning 2026.pdf');
});

/* ------------------------------------------------------------------ *
 * MIME assembly
 * ------------------------------------------------------------------ */

test('plain text message has the expected headers and decodable body', () => {
  const raw = buildMimeMessage({
    from: 'erik@example.com',
    to: ['anna@example.com'],
    subject: 'Hello',
    bodyText: 'Hi there',
  });

  assert.match(raw, /^From: erik@example\.com\r\n/);
  assert.match(raw, /\r\nTo: anna@example\.com\r\n/);
  assert.match(raw, /\r\nSubject: Hello\r\n/);
  assert.match(raw, /Content-Type: text\/plain; charset="UTF-8"/);

  const body = raw.split('\r\n\r\n').pop()!;
  assert.equal(Buffer.from(body, 'base64').toString('utf8'), 'Hi there');
});

test('non-ASCII subject is RFC 2047 encoded', () => {
  const raw = buildMimeMessage({
    from: 'erik@example.com',
    to: ['anna@example.com'],
    subject: 'Årsmöte på måndag',
    bodyText: 'x',
  });
  const subject = /\r\nSubject: (.+)\r\n/.exec(raw)![1]!;
  assert.match(subject, /^=\?UTF-8\?B\?/);
  const encoded = /^=\?UTF-8\?B\?(.+)\?=$/.exec(subject)![1]!;
  assert.equal(Buffer.from(encoded, 'base64').toString('utf8'), 'Årsmöte på måndag');
});

test('cc and bcc are emitted only when present', () => {
  const withCc = buildMimeMessage({
    from: 'a@x.com',
    to: ['b@x.com'],
    cc: ['c@x.com', 'd@x.com'],
    subject: 's',
    bodyText: 'b',
  });
  assert.match(withCc, /\r\nCc: c@x\.com, d@x\.com\r\n/);
  assert.doesNotMatch(withCc, /\r\nBcc:/);
});

test('reply headers are included so clients thread correctly', () => {
  const raw = buildMimeMessage({
    from: 'a@x.com',
    to: ['b@x.com'],
    subject: 'Re: hi',
    bodyText: 'reply',
    inReplyTo: '<abc@mail.example>',
    references: '<abc@mail.example>',
  });
  assert.match(raw, /\r\nIn-Reply-To: <abc@mail\.example>\r\n/);
  assert.match(raw, /\r\nReferences: <abc@mail\.example>\r\n/);
});

test('html body produces a multipart/alternative with both parts', () => {
  const raw = buildMimeMessage({
    from: 'a@x.com',
    to: ['b@x.com'],
    subject: 's',
    bodyText: 'plain version',
    bodyHtml: '<p>html version</p>',
  });
  assert.match(raw, /Content-Type: multipart\/alternative; boundary="alt_/);
  assert.match(raw, /Content-Type: text\/plain/);
  assert.match(raw, /Content-Type: text\/html/);

  const boundary = /boundary="(alt_[^"]+)"/.exec(raw)![1]!;
  assert.ok(raw.includes(`--${boundary}--`), 'alternative part must be closed');
});

test('attachments produce a well-formed multipart/mixed', () => {
  const content = Buffer.from('%PDF-1.4 fake pdf bytes');
  const raw = buildMimeMessage({
    from: 'a@x.com',
    to: ['b@x.com'],
    subject: 's',
    bodyText: 'see attached',
    attachments: [{ filename: 'report.pdf', mimeType: 'application/pdf', content }],
  });

  const boundary = /boundary="(mixed_[^"]+)"/.exec(raw)![1]!;
  assert.match(raw, /Content-Type: multipart\/mixed/);
  assert.match(raw, /Content-Disposition: attachment; filename="report\.pdf"/);
  assert.ok(raw.endsWith(`--${boundary}--`), 'mixed part must be closed last');

  // Exactly two body parts plus the closing delimiter.
  const openings = raw.split(`--${boundary}`).length - 1;
  assert.equal(openings, 3, 'body part, attachment part, and terminator');

  const attachmentSection = raw.split(`--${boundary}`)[2]!;
  const b64 = attachmentSection.split('\r\n\r\n')[1]!.replace(/\r\n/g, '');
  assert.deepEqual(Buffer.from(b64, 'base64'), content);
});

test('long attachments are base64 folded to legal line lengths', () => {
  const raw = buildMimeMessage({
    from: 'a@x.com',
    to: ['b@x.com'],
    subject: 's',
    bodyText: 'x',
    attachments: [
      { filename: 'big.bin', mimeType: 'application/octet-stream', content: Buffer.alloc(5000, 7) },
    ],
  });
  const tooLong = raw.split('\r\n').filter((line) => line.length > 998);
  assert.equal(tooLong.length, 0, 'no line may exceed the RFC 5322 limit');
});

/* ------------------------------------------------------------------ *
 * Gmail payload parsing
 * ------------------------------------------------------------------ */

const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64url');

test('parseMessage extracts headers, plain body and attachments', () => {
  const parsed = parseMessage({
    id: 'm1',
    threadId: 't1',
    labelIds: ['INBOX', 'UNREAD'],
    snippet: 'Hi there',
    internalDate: '1735689600000',
    payload: {
      mimeType: 'multipart/mixed',
      headers: [
        { name: 'From', value: 'Anna <anna@example.com>' },
        { name: 'To', value: 'erik@example.com' },
        { name: 'Subject', value: 'Invoice' },
        { name: 'Date', value: 'Wed, 1 Jan 2026 00:00:00 +0000' },
        { name: 'Message-ID', value: '<msg1@example>' },
      ],
      parts: [
        { mimeType: 'text/plain', body: { data: b64('Hello Erik') } },
        {
          mimeType: 'application/pdf',
          filename: 'invoice.pdf',
          body: { attachmentId: 'att1', size: 1234 },
        },
      ],
    },
  });

  assert.equal(parsed.from, 'Anna <anna@example.com>');
  assert.equal(parsed.subject, 'Invoice');
  assert.equal(parsed.messageIdHeader, '<msg1@example>');
  assert.equal(parsed.bodyText, 'Hello Erik');
  assert.equal(parsed.bodyIsHtmlFallback, false);
  assert.equal(parsed.internalDate, 1735689600000);
  assert.deepEqual(parsed.attachments, [
    { attachmentId: 'att1', filename: 'invoice.pdf', mimeType: 'application/pdf', sizeBytes: 1234 },
  ]);
});

test('parseMessage falls back to HTML when there is no plain part', () => {
  const parsed = parseMessage({
    id: 'm2',
    threadId: 't2',
    payload: {
      mimeType: 'text/html',
      headers: [{ name: 'Subject', value: 'Newsletter' }],
      body: { data: b64('<html><body><p>Line one</p><p>Line two</p></body></html>') },
    },
  });

  assert.equal(parsed.bodyIsHtmlFallback, true);
  assert.equal(parsed.bodyText, 'Line one\n\nLine two');
});

test('parseMessage finds attachments nested several levels deep', () => {
  const parsed = parseMessage({
    id: 'm3',
    threadId: 't3',
    payload: {
      mimeType: 'multipart/mixed',
      parts: [
        {
          mimeType: 'multipart/related',
          parts: [
            {
              mimeType: 'multipart/alternative',
              parts: [{ mimeType: 'text/plain', body: { data: b64('deep body') } }],
            },
            { mimeType: 'image/png', filename: 'logo.png', body: { attachmentId: 'a9', size: 10 } },
          ],
        },
      ],
    },
  });

  assert.equal(parsed.bodyText, 'deep body');
  assert.equal(parsed.attachments.length, 1);
  assert.equal(parsed.attachments[0]!.filename, 'logo.png');
});

test('summarize reports unread state and carries no body or attachment claim', () => {
  const s = summarize({
    id: 'm4',
    threadId: 't4',
    labelIds: ['INBOX', 'UNREAD'],
    snippet: 'preview text',
    internalDate: '1000',
    payload: { headers: [{ name: 'Subject', value: 'Hi' }] },
  });

  assert.equal(s.isUnread, true);
  assert.equal(s.subject, 'Hi');
  assert.equal(s.snippet, 'preview text');
  assert.ok(!('bodyText' in s), 'summaries must not carry bodies');
  // Search uses Gmail's `metadata` format, which omits the MIME part tree, so a
  // hasAttachments field here could only ever be wrong. Callers filter with the
  // `has:attachment` query operator instead.
  assert.ok(!('hasAttachments' in s), 'summaries must not claim to know about attachments');
});

/* ------------------------------------------------------------------ *
 * Calendar mapping
 * ------------------------------------------------------------------ */

test('toEventSummary handles a timed event with attendees', () => {
  const e = toEventSummary({
    id: 'e1',
    status: 'confirmed',
    summary: 'Standup',
    start: { dateTime: '2026-08-03T09:00:00+02:00' },
    end: { dateTime: '2026-08-03T09:15:00+02:00' },
    organizer: { email: 'boss@example.com' },
    attendees: [
      { email: 'erik@example.com', self: true, responseStatus: 'accepted' },
      { email: 'anna@example.com', responseStatus: 'needsAction', optional: true },
    ],
  });

  assert.equal(e.allDay, false);
  assert.equal(e.start, '2026-08-03T09:00:00+02:00');
  assert.equal(e.selfResponseStatus, 'accepted');
  assert.equal(e.attendees.length, 2);
  assert.equal(e.attendees[1]!.optional, true);
});

test('toEventSummary marks all-day events', () => {
  const e = toEventSummary({
    id: 'e2',
    summary: 'Holiday',
    start: { date: '2026-12-24' },
    end: { date: '2026-12-26' },
  });

  assert.equal(e.allDay, true);
  assert.equal(e.start, '2026-12-24');
  assert.equal(e.selfResponseStatus, null);
});

test('toEventSummary supplies a placeholder title for untitled events', () => {
  const e = toEventSummary({ id: 'e3', start: { date: '2026-01-01' }, end: { date: '2026-01-02' } });
  assert.equal(e.summary, '(no title)');
});

/* ------------------------------------------------------------------ *
 * Token refresh window
 * ------------------------------------------------------------------ */

test('our refresh window is wider than google-auth-library\'s eager-refresh threshold', async () => {
  // The regression this guards: we used to refresh 60s before expiry while the
  // library eagerly refreshes 5 minutes before. In that band we handed over a
  // token we thought was fresh, the library decided to renew it, found no
  // refresh_token on the client, and threw "No refresh token is set." — which
  // surfaced as an empty result rather than an actionable error.
  // Read the threshold out of the installed library rather than hard-coding it,
  // so the test keeps guarding the invariant if the library ever changes it.
  const libSource = await readFile(
    new URL('../node_modules/google-auth-library/build/src/auth/authclient.js', import.meta.url),
    'utf8',
  );
  const libMatch = /DEFAULT_EAGER_REFRESH_THRESHOLD_MILLIS = ([\d *]+);/.exec(libSource);
  assert.ok(libMatch, 'could not read the library\'s eager-refresh threshold');
  const DEFAULT_EAGER_REFRESH_THRESHOLD_MILLIS = libMatch[1]!
    .split('*')
    .map((n) => Number(n.trim()))
    .reduce((a, b) => a * b, 1);

  const source = await readFile(new URL('./google/oauth.ts', import.meta.url), 'utf8');

  const declared = /const EXPIRY_SKEW = (\d+)/.exec(source);
  assert.ok(declared, 'EXPIRY_SKEW must be declared in google/oauth.ts');

  const ourSkewMs = Number(declared[1]) * 1000;
  assert.ok(
    ourSkewMs > DEFAULT_EAGER_REFRESH_THRESHOLD_MILLIS,
    `EXPIRY_SKEW (${ourSkewMs}ms) must exceed the library's eager-refresh threshold ` +
      `(${DEFAULT_EAGER_REFRESH_THRESHOLD_MILLIS}ms), or refreshes race in the gap`,
  );
});

test('the client is always given a refresh token alongside the access token', async () => {
  // Belt to the skew's braces: even if the windows ever cross again, a client
  // holding a refresh token can renew itself instead of throwing.
  const source = await readFile(new URL('./google/oauth.ts', import.meta.url), 'utf8');
  const setCredentialsCalls = source.match(/client\.setCredentials\(\{[\s\S]*?\}\);/g) ?? [];

  assert.ok(setCredentialsCalls.length >= 2, 'expected both the cached and refreshed paths');
  for (const call of setCredentialsCalls) {
    assert.match(
      call,
      /refresh_token/,
      `every setCredentials call must pass refresh_token, found one without:\n${call}`,
    );
  }
});

test('a missing-refresh-token error is classified as needing re-authentication', async () => {
  const source = await readFile(new URL('./google/oauth.ts', import.meta.url), 'utf8');
  const classifier = /const looksLikeAuthFailure =[\s\S]*?;\n/.exec(source);
  assert.ok(classifier, 'auth-failure classifier must exist');
  assert.match(
    classifier[0],
    /no refresh token is set/i,
    'the classifier must recognise the library\'s missing-refresh-token error, ' +
      'otherwise it passes through as an anonymous failure',
  );
});

/* ------------------------------------------------------------------ *
 * Partial-failure reporting
 * ------------------------------------------------------------------ */

test('a partial result leads with an unmissable incomplete flag', async () => {
  const { partial } = await import('./mcp/reply.js');

  const result = partial(
    { query: 'is:inbox', totalResults: 0, messages: [] },
    [{ account: 'a@x.com', error: 'needs_reauth', reauthUrl: 'https://example.test/reauth/x' }],
    'search results',
  );

  const payload = JSON.parse((result.content[0] as { text: string }).text);
  const keys = Object.keys(payload);

  assert.equal(payload.incomplete, true);
  assert.equal(keys[0], 'incomplete', 'the flag must come first so a skimming reader sees it');
  assert.equal(keys[1], 'warning', 'the explanation must come second');
  assert.match(payload.warning, /INCOMPLETE RESULT/);
  assert.match(payload.warning, /a@x\.com/, 'the affected mailbox must be named');
  assert.match(payload.warning, /renew access/, 'a reauth-able failure must say so');
  // The zero-result trap: totalResults 0 must never be readable as "nothing found".
  assert.equal(payload.totalResults, 0);
  assert.equal(payload.accountsWithProblems.length, 1);
});

test('a fully successful result states plainly that it is complete', async () => {
  const { partial } = await import('./mcp/reply.js');

  const result = partial({ totalResults: 3, messages: [1, 2, 3] }, [], 'search results');
  const payload = JSON.parse((result.content[0] as { text: string }).text);

  assert.equal(payload.incomplete, false);
  assert.ok(!('warning' in payload));
  assert.ok(!('accountsWithProblems' in payload));
});

/* ------------------------------------------------------------------ *
 * Drive
 * ------------------------------------------------------------------ */

test('Google-native files are recognised as needing export', async () => {
  const { toFileSummary, isGoogleNative, isFolder } = await import('./google/drive.js');

  const doc = toFileSummary({ id: 'd1', name: 'Notes', mimeType: 'application/vnd.google-apps.document' });
  assert.equal(doc.kind, 'google-doc');
  assert.equal(doc.needsExport, true, 'a Google Doc has no bytes of its own');

  const pdf = toFileSummary({ id: 'f1', name: 'a.pdf', mimeType: 'application/pdf', size: '2048' });
  assert.equal(pdf.kind, 'file');
  assert.equal(pdf.needsExport, false);
  assert.equal(pdf.sizeBytes, 2048);

  // A folder is Google-native but must never be treated as an exportable file.
  const folder = toFileSummary({ id: 'x1', name: 'Docs', mimeType: 'application/vnd.google-apps.folder' });
  assert.equal(folder.kind, 'folder');
  assert.equal(isGoogleNative(folder.mimeType), true);
  assert.equal(isFolder(folder.mimeType), true);
  assert.equal(folder.needsExport, false, 'a folder must not be offered for export');
});

test('each Google-native type has a text and a binary export target', async () => {
  const { defaultTextExport, defaultBinaryExport, extensionForExport, GOOGLE_DOC, GOOGLE_SHEET, GOOGLE_SLIDES } =
    await import('./google/drive.js');

  assert.equal(defaultTextExport(GOOGLE_DOC), 'text/markdown');
  assert.equal(defaultTextExport(GOOGLE_SHEET), 'text/csv');
  assert.equal(defaultTextExport(GOOGLE_SLIDES), 'text/plain');
  assert.equal(defaultTextExport('application/pdf'), null, 'ordinary files are not exported');

  assert.match(defaultBinaryExport(GOOGLE_DOC)!, /wordprocessingml/);
  assert.match(defaultBinaryExport(GOOGLE_SHEET)!, /spreadsheetml/);
  assert.match(defaultBinaryExport(GOOGLE_SLIDES)!, /presentationml/);

  // The extension matters: an exported Doc saved without one is unopenable.
  assert.equal(extensionForExport(defaultBinaryExport(GOOGLE_DOC)!), '.docx');
  assert.equal(extensionForExport(defaultBinaryExport(GOOGLE_SHEET)!), '.xlsx');
  assert.equal(extensionForExport('text/csv'), '.csv');
});

test('a shared-drive file is flagged as such', async () => {
  const { toFileSummary } = await import('./google/drive.js');
  const shared = toFileSummary({
    id: 's1', name: 'Team plan', mimeType: 'application/pdf', driveId: 'drv_1', shared: true,
  });
  assert.equal(shared.inSharedDrive, true);
  assert.equal(shared.shared, true);
});

test('every Drive call opts into shared drives', async () => {
  // Without supportsAllDrives/includeItemsFromAllDrives the API silently omits
  // shared-drive content, so a search returns a confident, wrong "no results".
  const source = await readFile(new URL('./google/drive.ts', import.meta.url), 'utf8');
  assert.match(source, /supportsAllDrives: true/);
  assert.match(source, /includeItemsFromAllDrives: true/);

  const listCalls = source.match(/drive\.files\.list\(\{[\s\S]*?\}\);/g) ?? [];
  assert.ok(listCalls.length >= 2, 'expected search and folder listing');
  for (const call of listCalls) {
    assert.match(call, /ALL_DRIVES/, `a files.list call omits shared drives:\n${call}`);
  }
});

test('the server can never create public link sharing', async () => {
  const source = await readFile(new URL('./google/drive.ts', import.meta.url), 'utf8');
  const createCall = /drive\.permissions\.create\(\{[\s\S]*?\}\);/.exec(source);
  assert.ok(createCall, 'permission creation must exist');
  assert.match(createCall[0], /type: 'user'/, 'permissions must be granted to named users only');
  assert.doesNotMatch(
    createCall[0],
    /type: 'anyone'|type: 'domain'/,
    'this server must not be able to make a file publicly or domain-wide accessible',
  );
});

test('deletion is always reversible', async () => {
  const source = await readFile(new URL('./google/drive.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(
    source,
    /drive\.files\.delete\(/,
    'files.delete is permanent; this server must only ever trash',
  );
  assert.match(source, /trashed: true/, 'trashing must be implemented');
  assert.match(source, /trashed: false/, 'restoring must be implemented');
});

/* ------------------------------------------------------------------ *
 * Capability / scope drift
 * ------------------------------------------------------------------ */

test('an account is only granted a capability its stored scopes cover', async () => {
  const { hasCapability } = await import('./google/oauth.js');
  const base = {
    id: 'a', user_id: 'u', email: 'x@y.com', provider: 'google' as const, provider_sub: null,
    display_name: null,
    refresh_token_enc: null, access_token_enc: null, access_token_expires: null,
    status: 'active' as const, last_error: null, last_ok_at: null, created_at: 0, updated_at: 0,
  };

  const old = { ...base, scopes: 'https://www.googleapis.com/auth/gmail.modify https://www.googleapis.com/auth/calendar' };
  assert.equal(hasCapability(old, 'gmail'), true);
  assert.equal(hasCapability(old, 'calendar'), true);
  assert.equal(hasCapability(old, 'drive'), false, 'an account predating Drive must not claim it');

  const current = { ...base, scopes: `${old.scopes} https://www.googleapis.com/auth/drive` };
  assert.equal(hasCapability(current, 'drive'), true);

  // A partial match must not count: drive.file is not drive.
  const narrow = { ...base, scopes: 'https://www.googleapis.com/auth/drive.file' };
  assert.equal(hasCapability(narrow, 'drive'), false, 'drive.file must not satisfy full drive');
});

test('every capability Google supports is in the requested scope set', async () => {
  const { GOOGLE_SCOPES, SCOPE_FOR } = await import('./config.js');

  for (const [capability, scope] of Object.entries(SCOPE_FOR)) {
    if (scope === null) continue;
    assert.ok(
      (GOOGLE_SCOPES as readonly string[]).includes(scope),
      `consent must request ${scope}, or no account can ever grant ${capability}`,
    );
  }
});

/* ------------------------------------------------------------------ *
 * Sheets A1 notation
 * ------------------------------------------------------------------ */

test('column letters convert to indices and back', async () => {
  const { columnToIndex, indexToColumn } = await import('./google/sheets.js');
  const cases: Array<[string, number]> = [['A', 0], ['B', 1], ['Z', 25], ['AA', 26], ['AB', 27], ['BA', 52], ['ZZ', 701], ['AAA', 702]];
  for (const [letters, index] of cases) {
    assert.equal(columnToIndex(letters), index, `${letters} should be ${index}`);
    assert.equal(indexToColumn(index), letters, `${index} should be ${letters}`);
  }
});

test('A1 ranges become the half-open zero-based indices GridRange needs', async () => {
  const { parseA1 } = await import('./google/sheets.js');

  // The classic off-by-one: B2:D10 is rows 1..10 and columns 1..4, because the
  // start is inclusive and zero-based while the end is exclusive.
  assert.deepEqual(parseA1('Sheet1!B2:D10'), {
    tabName: 'Sheet1', startRowIndex: 1, endRowIndex: 10, startColumnIndex: 1, endColumnIndex: 4,
  });

  // A single cell is a one-by-one range, not an unbounded one.
  assert.deepEqual(parseA1('B2'), {
    tabName: null, startRowIndex: 1, endRowIndex: 2, startColumnIndex: 1, endColumnIndex: 2,
  });
});

test('A1 handles quoted tab names with spaces', async () => {
  const { parseA1 } = await import('./google/sheets.js');
  assert.equal(parseA1("'Jul 2026'!A1:F1").tabName, 'Jul 2026');
  assert.equal(parseA1('Jul 2026!A1').tabName, 'Jul 2026');
  // A doubled quote inside a quoted name is an escaped single quote.
  assert.equal(parseA1("'Erik''s tab'!A1").tabName, "Erik's tab");
});

test('A1 handles whole-column, whole-row and whole-tab ranges', async () => {
  const { parseA1 } = await import('./google/sheets.js');

  // Whole columns: rows must stay unbounded, not default to 0.
  const cols = parseA1('A:C');
  assert.equal(cols.startColumnIndex, 0);
  assert.equal(cols.endColumnIndex, 3);
  assert.equal(cols.startRowIndex, undefined, 'rows must remain unbounded');
  assert.equal(cols.endRowIndex, undefined);

  const rows = parseA1('2:5');
  assert.equal(rows.startRowIndex, 1);
  assert.equal(rows.endRowIndex, 5);
  assert.equal(rows.startColumnIndex, undefined, 'columns must remain unbounded');

  // A bare unquoted string that is not a cell reference names the whole tab.
  assert.deepEqual(parseA1('Jun 2026'), { tabName: 'Jun 2026' });
  assert.deepEqual(parseA1('Log'), { tabName: 'Log' });
  // "Sheet1" is a tab name, not column SHEET row 1.
  assert.deepEqual(parseA1('Sheet1'), { tabName: 'Sheet1' });
  // ...but something that IS a valid cell reference still means that cell.
  assert.equal(parseA1('A1').tabName, null);
  assert.equal(parseA1('A1').startRowIndex, 0);

  const wholeTab = parseA1('Sheet1!');
  assert.equal(wholeTab.tabName, 'Sheet1');
  assert.equal(wholeTab.startRowIndex, undefined);
});

test('A1 rejects nonsense rather than guessing', async () => {
  const { parseA1 } = await import('./google/sheets.js');
  assert.throws(() => parseA1('Sheet1!A1:!!'), /Could not understand/);
});

test('hex colours convert to the API\'s 0..1 floats', async () => {
  const { hexToColor } = await import('./google/sheets.js');

  assert.deepEqual(hexToColor('#ffffff'), { red: 1, green: 1, blue: 1 });
  assert.deepEqual(hexToColor('000000'), { red: 0, green: 0, blue: 0 });

  const blue = hexToColor('#1a73e8');
  assert.ok(Math.abs(blue.red! - 26 / 255) < 1e-9);
  assert.ok(Math.abs(blue.green! - 115 / 255) < 1e-9);
  assert.ok(Math.abs(blue.blue! - 232 / 255) < 1e-9);

  assert.throws(() => hexToColor('#fff'), /six-digit hex/);
  assert.throws(() => hexToColor('not a colour'), /six-digit hex/);
});

test('formatting only touches the properties that were supplied', async () => {
  // An over-broad fields mask silently resets styling the caller never mentioned,
  // so the mask must be built from the supplied properties alone.
  const source = await readFile(new URL('./google/sheets.ts', import.meta.url), 'utf8');
  assert.match(source, /fields: fields\.join\(','\)/, 'the mask must be assembled, not hard-coded');
  assert.doesNotMatch(
    source,
    /fields: '\*'|fields: 'userEnteredFormat'/,
    'a wildcard mask would wipe unspecified formatting',
  );
});

test('a spreadsheet is never written through the Drive blob path', async () => {
  const source = await readFile(new URL('./google/sheets.ts', import.meta.url), 'utf8');
  // Everything structural must go through batchUpdate or values.*, never a
  // whole-file media upload, which is what destroys other tabs.
  assert.doesNotMatch(source, /files\.update|files\.create/, 'Sheets edits must not use the Drive file API');
  assert.match(source, /spreadsheets\.values\.update/);
  assert.match(source, /duplicateSheet/);
});

/* ------------------------------------------------------------------ *
 * Docs
 * ------------------------------------------------------------------ */

test('appending to a Doc inserts before the final newline', async () => {
  // Inserting at the reported endIndex is rejected by the API; it must be one
  // less. This is the most common Docs insertion failure.
  const source = await readFile(new URL('./google/docs.ts', import.meta.url), 'utf8');
  assert.match(source, /end - 1/, 'insertion index must step back off the trailing newline');
  assert.match(source, /Math\.max\(1,/, 'index must never fall below 1');
});

test('a heading is inserted and styled in a single batch', async () => {
  const source = await readFile(new URL('./google/docs.ts', import.meta.url), 'utf8');
  const batch = /appendHeading[\s\S]*?\n}/.exec(source);
  assert.ok(batch);
  assert.match(batch[0], /insertText/);
  assert.match(batch[0], /namedStyleType/, 'a real heading style, not just bold text');
  assert.equal(
    (batch[0].match(/batchUpdate/g) ?? []).length,
    1,
    'one batch, so the document is never left with an unstyled paragraph',
  );
});

/* ------------------------------------------------------------------ *
 * Disabled-API detection
 * ------------------------------------------------------------------ */

test('a disabled Google API is reported as a project setting, not a permission problem', async () => {
  const { apiDisabledMessage } = await import('./service.js');

  const real =
    'Google Sheets API has not been used in project 123456 before or it is disabled. ' +
    'Enable it by visiting https://console.developers.google.com/apis/api/sheets.googleapis.com/overview?project=123456 then retry.';

  const msg = apiDisabledMessage(real);
  assert.ok(msg, 'the disabled-API case must be recognised');
  assert.match(msg, /sheets API is not enabled/i);
  assert.match(msg, /no account needs to\s+sign in again/i, 'must not send the user through re-auth');
  assert.match(msg, /console\.developers\.google\.com/, 'must carry the enable link');

  assert.equal(apiDisabledMessage('Some other failure'), null, 'unrelated errors pass through');
  assert.equal(apiDisabledMessage(new Error('invalid_grant')), null);
});

/* ------------------------------------------------------------------ *
 * Calendar attendees and rooms
 * ------------------------------------------------------------------ */

test('a room is distinguishable from a person', async () => {
  const { toEventSummary } = await import('./google/calendar.js');
  const e = toEventSummary({
    id: 'e1',
    summary: 'Retro',
    start: { dateTime: '2026-08-12T13:00:00Z' },
    end: { dateTime: '2026-08-12T14:00:00Z' },
    organizer: { email: 'rikard@example.com' },
    attendees: [
      { email: 'rikard@example.com', displayName: 'Rikard', responseStatus: 'accepted', organizer: true },
      { email: 'erik@example.com', responseStatus: 'needsAction', self: true },
      {
        email: 'c_188@resource.calendar.google.com',
        displayName: 'FS-3-Reef (12) [TV]',
        responseStatus: 'accepted',
        resource: true,
      },
    ],
  });

  // Without these an agent cannot tell the opaque resource address from a person.
  const room = e.attendees.find((a) => a.isResource);
  assert.ok(room, 'the room must be flagged as a resource');
  assert.equal(room.displayName, 'FS-3-Reef (12) [TV]', 'the room must be nameable');
  assert.deepEqual(e.rooms.map((r) => r.email), ['c_188@resource.calendar.google.com']);
  assert.equal(e.attendees.filter((a) => !a.isResource).length, 2, 'people and rooms are separable');
  assert.equal(e.isOrganizer, false, 'organiser.self drives isOrganizer');
});

test('a recurring occurrence reports the series it belongs to', async () => {
  const { toEventSummary } = await import('./google/calendar.js');
  const instance = toEventSummary({
    id: 'abc_20260812T130000Z',
    recurringEventId: 'abc_R20260320T140000',
    start: { dateTime: '2026-08-12T13:00:00Z' },
    end: { dateTime: '2026-08-12T14:00:00Z' },
  });
  assert.equal(instance.isRecurringInstance, true);
  assert.equal(instance.recurringEventId, 'abc_R20260320T140000');

  const oneOff = toEventSummary({ id: 'x', start: { date: '2026-08-12' }, end: { date: '2026-08-13' } });
  assert.equal(oneOff.isRecurringInstance, false);
  assert.equal(oneOff.recurringEventId, null);
});

test('attendee changes merge instead of rewriting the guest list', async () => {
  // The regression this guards: sending `{email}` objects for everyone drops the
  // booked room and resets every RSVP. Existing attendee objects must survive.
  const source = await readFile(new URL('./google/calendar.ts', import.meta.url), 'utf8');
  const fn = /export async function changeAttendees[\s\S]*?\n}/.exec(source);
  assert.ok(fn, 'changeAttendees must exist');
  assert.match(fn[0], /events\.get\(/, 'it must read the current attendees before patching');
  assert.match(fn[0], /const kept = existing\.find/, 'surviving attendees must be carried over whole');
  assert.match(fn[0], /toLowerCase/, 'address matching must be case-insensitive');
});

test('changeAttendees preserves a room and RSVPs when adding one person', async () => {
  const { changeAttendees } = await import('./google/calendar.js');

  const existing = [
    { email: 'rikard@example.com', responseStatus: 'accepted', organizer: true },
    { email: 'c_188@resource.calendar.google.com', displayName: 'FS-3-Reef', responseStatus: 'accepted', resource: true },
  ];
  let sent: unknown;

  const fakeCal = {
    events: {
      get: async () => ({ data: { attendees: existing } }),
      patch: async (req: { requestBody: { attendees: unknown } }) => {
        sent = req.requestBody.attendees;
        return { data: { id: 'e1', attendees: req.requestBody.attendees } };
      },
    },
  } as never;

  const result = await changeAttendees(fakeCal, 'primary', 'e1', { add: ['Anna@Example.com'] }, 'all');

  const out = sent as Array<Record<string, unknown>>;
  assert.equal(out.length, 3, 'the new person is added to the existing two');
  assert.deepEqual(out[0], existing[0], 'the accepted RSVP is untouched');
  assert.deepEqual(out[1], existing[1], 'the room keeps its resource flag and booking');
  assert.deepEqual(out[2], { email: 'anna@example.com' }, 'the new address is normalised');
  assert.deepEqual(result.added, ['anna@example.com']);
  assert.deepEqual(result.removed, []);
  assert.equal(result.unchanged, 2);
});

test('changeAttendees will not add someone twice', async () => {
  const { changeAttendees } = await import('./google/calendar.js');
  let sent: Array<Record<string, unknown>> = [];
  const fakeCal = {
    events: {
      get: async () => ({ data: { attendees: [{ email: 'anna@example.com', responseStatus: 'accepted' }] } }),
      patch: async (req: { requestBody: { attendees: Array<Record<string, unknown>> } }) => {
        sent = req.requestBody.attendees;
        return { data: { id: 'e1' } };
      },
    },
  } as never;

  const result = await changeAttendees(fakeCal, 'primary', 'e1', { add: ['ANNA@example.com'] }, 'none');
  assert.equal(sent.length, 1, 'a differently-cased duplicate must not be added again');
  assert.deepEqual(result.added, []);
  assert.equal(sent[0]!.responseStatus, 'accepted', 'and their RSVP survives');
});

test('replacing the guest list still preserves survivors', async () => {
  const { changeAttendees } = await import('./google/calendar.js');
  let sent: Array<Record<string, unknown>> = [];
  const existing = [
    { email: 'anna@example.com', responseStatus: 'accepted' },
    { email: 'bo@example.com', responseStatus: 'declined' },
  ];
  const fakeCal = {
    events: {
      get: async () => ({ data: { attendees: existing } }),
      patch: async (req: { requestBody: { attendees: Array<Record<string, unknown>> } }) => {
        sent = req.requestBody.attendees;
        return { data: { id: 'e1' } };
      },
    },
  } as never;

  const result = await changeAttendees(
    fakeCal, 'primary', 'e1', { replace: ['anna@example.com', 'cecilia@example.com'] }, 'all',
  );

  assert.equal(sent.length, 2);
  assert.equal(sent[0]!.responseStatus, 'accepted', 'a retained guest keeps their RSVP');
  assert.deepEqual(sent[1], { email: 'cecilia@example.com' });
  assert.deepEqual(result.removed, ['bo@example.com']);
  assert.deepEqual(result.added, ['cecilia@example.com']);
});

/* ------------------------------------------------------------------ *
 * Google API field masks
 * ------------------------------------------------------------------ */

test('no field mask mixes dot notation with sub-selection parentheses', async () => {
  // "sheets.properties(sheetId,title)" is rejected by Google as an invalid
  // argument — sub-selection must nest, as "sheets(properties(sheetId,title))".
  // The request fails wholesale, so one bad mask takes out an entire tool while
  // its neighbours keep working, which makes it look like a permissions problem.
  const files = ['./google/sheets.ts', './google/drive.ts', './google/docs.ts', './google/calendar.ts'];
  const offenders: string[] = [];

  for (const file of files) {
    const source = await readFile(new URL(file, import.meta.url), 'utf8');

    // Collect the string literals belonging to a `fields:` assignment, which may
    // continue over several concatenated lines.
    const lines = source.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (!/\bfields:/.test(lines[i]!)) continue;

      let mask = '';
      for (let j = i; j < Math.min(i + 6, lines.length); j++) {
        const line = lines[j]!;
        if (line.trimStart().startsWith('//')) continue;
        for (const m of line.matchAll(/'([^']*)'/g)) mask += m[1];
        if (/[,)]\s*$/.test(line.trim()) && j > i) break;
        if (j > i && !/\+\s*$/.test(line.trim())) break;
      }

      if (/[A-Za-z][A-Za-z0-9]*\.[A-Za-z][A-Za-z0-9]*\(/.test(mask)) {
        offenders.push(`${file}: ${mask}`);
      }
    }
  }

  assert.deepEqual(offenders, [], `invalid field mask(s):\n${offenders.join('\n')}`);
});

test('the spreadsheet mask nests its sub-selection', async () => {
  const source = await readFile(new URL('./google/sheets.ts', import.meta.url), 'utf8');
  assert.match(source, /sheets\(properties\(/, 'sub-selection must nest');
  assert.doesNotMatch(
    source,
    /'sheets\.properties\(/,
    'sheets.properties(...) is the invalid form that broke list_sheet_tabs',
  );
});

/* ------------------------------------------------------------------ *
 * Microsoft: query translation
 *
 * The tools promise one query language across both providers, so these check
 * that a Gmail-shaped query keeps its meaning rather than quietly losing terms.
 * ------------------------------------------------------------------ */

test('a Gmail query becomes KQL when it needs full-text matching', async () => {
  const { translateQuery } = await import('./microsoft/query.js');

  const t = translateQuery('from:anna@example.com after:2026/01/01 has:attachment');
  assert.equal(t.mode, 'search');
  assert.match(t.kql!, /from:anna@example\.com/);
  assert.match(t.kql!, /received>=2026-01-01/);
  assert.match(t.kql!, /hasAttachments:true/);
  assert.equal(t.unsupported.length, 0);
});

test('a query of only filterable terms is filtered, so results stay date-ordered', async () => {
  const { translateQuery } = await import('./microsoft/query.js');

  const t = translateQuery('is:unread has:attachment');
  assert.equal(t.mode, 'filter', '$search would forbid $orderby and scramble the order');
  assert.match(t.odataFilter!, /hasAttachments eq true/);
  assert.match(t.odataFilter!, /isRead eq false/);
  // Already in the query; applying it again afterwards would be misleading.
  assert.equal(t.requireUnread, null);
});

test('read state survives a query that has to use search', async () => {
  const { translateQuery } = await import('./microsoft/query.js');

  const t = translateQuery('is:unread from:anna');
  assert.equal(t.mode, 'search');
  assert.match(t.kql!, /from:anna/);
  assert.equal(t.requireUnread, true, 'KQL cannot express unread, so it must be applied after');
});

test('folder words map to Outlook folders, and labels to categories', async () => {
  const { translateQuery } = await import('./microsoft/query.js');

  assert.equal(translateQuery('in:trash').folder, 'deleteditems');
  assert.equal(translateQuery('in:spam').folder, 'junkemail');
  assert.equal(translateQuery('in:sent').folder, 'sentitems');

  const label = translateQuery('label:Kunder');
  assert.match(label.kql!, /category:Kunder/);
});

test('an operator Outlook cannot honour is reported, not silently dropped', async () => {
  const { translateQuery } = await import('./microsoft/query.js');

  const t = translateQuery('bcc:anna@example.com subject:invoice');
  assert.equal(t.unsupported.length, 1);
  assert.match(t.unsupported[0]!, /bcc/);
  assert.doesNotMatch(t.kql!, /bcc/, 'the term must not leak into the query as free text');
});

test('negation is carried through both query forms', async () => {
  const { translateQuery } = await import('./microsoft/query.js');

  assert.match(translateQuery('-from:noreply@example.com other').kql!, /NOT from:noreply@example\.com/);
  assert.match(translateQuery('-has:attachment').odataFilter!, /not \(hasAttachments eq true\)/);
});

test('relative dates are resolved against a fixed reference', async () => {
  const { translateQuery } = await import('./microsoft/query.js');

  const t = translateQuery('newer_than:7d', new Date('2026-08-18T12:00:00Z'));
  assert.match(t.odataFilter!, /receivedDateTime ge 2026-08-11T00:00:00Z/);
});

test('an empty query lists recent mail rather than searching for nothing', async () => {
  const { translateQuery } = await import('./microsoft/query.js');

  const t = translateQuery('');
  assert.equal(t.mode, 'filter');
  assert.equal(t.odataFilter, null);
  assert.equal(t.kql, null);
});

test('a quoted phrase stays one term', async () => {
  const { translateQuery } = await import('./microsoft/query.js');

  const t = translateQuery('subject:"quarterly report"');
  assert.match(t.kql!, /subject:"quarterly report"/);
});

/* ------------------------------------------------------------------ *
 * Microsoft: capabilities
 * ------------------------------------------------------------------ */

const microsoftAccount = (scopes: string) => ({
  id: 'm', user_id: 'u', email: 'x@corp.com', provider: 'microsoft' as const, provider_sub: null,
  display_name: null, refresh_token_enc: null, access_token_enc: null, access_token_expires: null,
  status: 'active' as const, last_error: null, last_ok_at: null, created_at: 0, updated_at: 0,
  scopes,
});

test('Graph scopes are recognised however Microsoft qualifies them', async () => {
  const { hasCapability } = await import('./oauth/capabilities.js');

  // Microsoft echoes scopes back fully qualified and not always in the casing
  // they were requested in.
  const account = microsoftAccount(
    'https://graph.microsoft.com/Mail.ReadWrite https://graph.microsoft.com/calendars.readwrite',
  );
  assert.equal(hasCapability(account, 'gmail'), true);
  assert.equal(hasCapability(account, 'calendar'), true);
});

test('a Google scope never satisfies a Microsoft account, or the reverse', async () => {
  const { hasCapability } = await import('./oauth/capabilities.js');

  const confused = microsoftAccount('https://www.googleapis.com/auth/gmail.modify');
  assert.equal(hasCapability(confused, 'gmail'), false);
});

test('Drive against a Microsoft mailbox is unsupported, not a missing permission', async () => {
  const { requireCapability } = await import('./oauth/capabilities.js');
  const { ScopeMissingError, UnsupportedForProviderError } = await import('./oauth/errors.js');

  const account = microsoftAccount('https://graph.microsoft.com/Mail.ReadWrite');

  assert.throws(
    () => requireCapability(account, 'drive'),
    (err: unknown) => {
      // The distinction matters: a ScopeMissingError sends the user off to
      // re-consent, which could never make OneDrive appear behind these tools.
      assert.ok(err instanceof UnsupportedForProviderError);
      assert.ok(!(err instanceof ScopeMissingError));
      return true;
    },
  );
});

test('every capability Microsoft supports is in the requested scope set', async () => {
  const { GRAPH_SCOPES, GRAPH_SCOPE_FOR } = await import('./config.js');

  for (const [capability, scope] of Object.entries(GRAPH_SCOPE_FOR)) {
    if (scope === null) continue;
    assert.ok(
      (GRAPH_SCOPES as readonly string[]).includes(scope),
      `consent must request ${scope}, or no account can ever grant ${capability}`,
    );
  }
  assert.ok(
    (GRAPH_SCOPES as readonly string[]).includes('offline_access'),
    'without offline_access there is no refresh token and every grant dies within the hour',
  );
});

/* ------------------------------------------------------------------ *
 * Microsoft: recurrence
 * ------------------------------------------------------------------ */

test('a weekly RRULE becomes an Outlook weekly pattern', async () => {
  const { rruleToGraph } = await import('./microsoft/recurrence.js');

  const r = rruleToGraph(['RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=TU,TH;COUNT=10'], '2026-08-18');
  assert.equal(r.pattern.type, 'weekly');
  assert.equal(r.pattern.interval, 2);
  assert.deepEqual(r.pattern.daysOfWeek, ['tuesday', 'thursday']);
  assert.equal(r.range.type, 'numbered');
  assert.equal(r.range.numberOfOccurrences, 10);
});

test('a weekly rule without BYDAY repeats on the start date\'s weekday', async () => {
  const { rruleToGraph } = await import('./microsoft/recurrence.js');

  // 2026-08-18 is a Tuesday; leaving daysOfWeek empty would be rejected by Graph.
  const r = rruleToGraph(['RRULE:FREQ=WEEKLY'], '2026-08-18');
  assert.deepEqual(r.pattern.daysOfWeek, ['tuesday']);
});

test('an ordinal monthly rule becomes a relative pattern', async () => {
  const { rruleToGraph } = await import('./microsoft/recurrence.js');

  const r = rruleToGraph(['RRULE:FREQ=MONTHLY;BYDAY=2TU'], '2026-08-11');
  assert.equal(r.pattern.type, 'relativeMonthly');
  assert.equal(r.pattern.index, 'second');
  assert.deepEqual(r.pattern.daysOfWeek, ['tuesday']);

  const last = rruleToGraph(['RRULE:FREQ=MONTHLY;BYDAY=-1FR'], '2026-08-28');
  assert.equal(last.pattern.index, 'last');
});

test('UNTIL becomes an end date', async () => {
  const { rruleToGraph } = await import('./microsoft/recurrence.js');

  const r = rruleToGraph(['RRULE:FREQ=DAILY;UNTIL=20260901T000000Z'], '2026-08-18');
  assert.equal(r.range.type, 'endDate');
  assert.equal(r.range.endDate, '2026-09-01');
});

test('a rule Outlook cannot express is refused by name', async () => {
  const { rruleToGraph } = await import('./microsoft/recurrence.js');

  assert.throws(
    () => rruleToGraph(['RRULE:FREQ=HOURLY'], '2026-08-18'),
    /FREQ=HOURLY/,
    'silently dropping the rule would create a single event where a series was asked for',
  );
  assert.throws(() => rruleToGraph(['RRULE:FREQ=DAILY', 'RRULE:FREQ=WEEKLY'], '2026-08-18'), /single/);
});

test('an Outlook pattern reads back as the RRULE that produced it', async () => {
  const { rruleToGraph, graphToRrule } = await import('./microsoft/recurrence.js');

  const original = 'RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=TU,TH;COUNT=10';
  const back = graphToRrule(rruleToGraph([original], '2026-08-18'));
  assert.deepEqual(back, [original]);
});

/* ------------------------------------------------------------------ *
 * Microsoft: event mapping
 * ------------------------------------------------------------------ */

test('an Outlook event maps onto the same shape a Google one does', async () => {
  const { toEventSummary } = await import('./microsoft/calendar.js');

  const event = toEventSummary(
    {
      id: 'AAMk',
      subject: 'Sprint planning',
      start: { dateTime: '2026-08-18T09:00:00.0000000', timeZone: 'UTC' },
      end: { dateTime: '2026-08-18T10:00:00.0000000', timeZone: 'UTC' },
      isAllDay: false,
      isOrganizer: true,
      organizer: { emailAddress: { address: 'me@corp.com', name: 'Me' } },
      onlineMeeting: { joinUrl: 'https://teams.microsoft.com/l/x' },
      responseStatus: { response: 'organizer' },
      attendees: [
        {
          type: 'required',
          status: { response: 'tentativelyAccepted' },
          emailAddress: { address: 'anna@corp.com', name: 'Anna' },
        },
        {
          type: 'resource',
          status: { response: 'accepted' },
          emailAddress: { address: 'room-reef@corp.com', name: 'Reef (12)' },
        },
      ],
    },
    'me@corp.com',
  );

  assert.equal(event.start, '2026-08-18T09:00:00.000Z');
  assert.equal(event.hangoutLink, 'https://teams.microsoft.com/l/x');
  // Outlook's words translated into the ones every tool description promises.
  assert.equal(event.attendees[0]!.responseStatus, 'tentative');
  assert.equal(event.selfResponseStatus, 'accepted');
  assert.equal(event.rooms.length, 1, 'a room must stay distinguishable from a person');
  assert.equal(event.rooms[0]!.email, 'room-reef@corp.com');
  assert.equal(event.attendees[1]!.isResource, true);
});

test('an all-day event keeps its date whatever zone it is read in', async () => {
  const { toEventSummary } = await import('./microsoft/calendar.js');

  // Stockholm midnight on the 18th is 22:00 UTC on the 17th; taking the UTC
  // date directly would report the event a day early.
  const stockholm = toEventSummary(
    {
      id: '1',
      isAllDay: true,
      start: { dateTime: '2026-08-17T22:00:00.0000000', timeZone: 'UTC' },
      end: { dateTime: '2026-08-18T22:00:00.0000000', timeZone: 'UTC' },
    },
    'me@corp.com',
  );
  assert.equal(stockholm.allDay, true);
  assert.equal(stockholm.start, '2026-08-18');
  assert.equal(stockholm.end, '2026-08-19');

  // And the same holds for a zone behind UTC.
  const losAngeles = toEventSummary(
    {
      id: '2',
      isAllDay: true,
      start: { dateTime: '2026-08-18T07:00:00.0000000', timeZone: 'UTC' },
      end: { dateTime: '2026-08-19T07:00:00.0000000', timeZone: 'UTC' },
    },
    'me@corp.com',
  );
  assert.equal(losAngeles.start, '2026-08-18');
});

test('an occurrence reports the series it belongs to', async () => {
  const { toEventSummary } = await import('./microsoft/calendar.js');

  const occurrence = toEventSummary(
    { id: 'occ', type: 'occurrence', seriesMasterId: 'master' },
    'me@corp.com',
  );
  assert.equal(occurrence.isRecurringInstance, true);
  assert.equal(occurrence.recurringEventId, 'master');

  const single = toEventSummary({ id: 'one', type: 'singleInstance' }, 'me@corp.com');
  assert.equal(single.isRecurringInstance, false);
});

test('a Microsoft consent URL is distinct from a Google one and cannot be replayed at it', async () => {
  process.env.MICROSOFT_CLIENT_ID = 'ms-client';
  process.env.MICROSOFT_CLIENT_SECRET = 'ms-secret';

  const { signToken, verifyToken } = await import('./crypto.js');

  // The two callbacks use different state kinds, so a token minted for one is
  // rejected by the other rather than exchanged against the wrong credentials.
  const googleState = signToken({ k: 'oauth_state', exp: Math.floor(Date.now() / 1000) + 60, uid: 'u' });
  assert.equal(verifyToken(googleState, 'ms_oauth_state'), null);
});

/* ------------------------------------------------------------------ *
 * Teams chat: which mailboxes can use it
 * ------------------------------------------------------------------ */

const googleAccount = (scopes: string) => ({
  id: 'g', user_id: 'u', email: 'erik@dibbla.com', provider: 'google' as const, provider_sub: null,
  display_name: null, refresh_token_enc: null, access_token_enc: null, access_token_expires: null,
  status: 'active' as const, last_error: null, last_ok_at: null, created_at: 0, updated_at: 0,
  scopes,
});

const ALL_GOOGLE_SCOPES =
  'https://www.googleapis.com/auth/gmail.modify https://www.googleapis.com/auth/calendar ' +
  'https://www.googleapis.com/auth/drive';

test('chat against a Google mailbox is unsupported, and names Teams rather than Google Chat', async () => {
  const { requireCapability } = await import('./oauth/capabilities.js');
  const { ScopeMissingError, UnsupportedForProviderError } = await import('./oauth/errors.js');

  assert.throws(
    () => requireCapability(googleAccount(ALL_GOOGLE_SCOPES), 'chat'),
    (err: unknown) => {
      assert.ok(err instanceof UnsupportedForProviderError);
      // A ScopeMissingError would hand the user a renewal link, and no amount of
      // Google consent will ever put Teams chat behind these tools.
      assert.ok(!(err instanceof ScopeMissingError));
      assert.match((err as Error).message, /Teams chat/);
      assert.match((err as Error).message, /Microsoft mailbox/);
      return true;
    },
  );
});

test('a Microsoft mailbox connected before chat existed is told to extend, not that it is impossible', async () => {
  const { requireCapability } = await import('./oauth/capabilities.js');
  const { ScopeMissingError } = await import('./oauth/errors.js');

  // Mail and calendar only: the grant is alive but predates Chat.ReadWrite.
  const older = microsoftAccount(
    'https://graph.microsoft.com/Mail.ReadWrite https://graph.microsoft.com/Calendars.ReadWrite',
  );
  assert.throws(() => requireCapability(older, 'chat'), ScopeMissingError);

  const current = microsoftAccount(
    'https://graph.microsoft.com/Mail.ReadWrite https://graph.microsoft.com/Chat.ReadWrite',
  );
  assert.doesNotThrow(() => requireCapability(current, 'chat'));
});

test('each account reports only the capabilities it really has', async () => {
  const { capabilitiesOf } = await import('./oauth/capabilities.js');

  assert.deepEqual(capabilitiesOf(googleAccount(ALL_GOOGLE_SCOPES)), [
    'gmail',
    'calendar',
    'drive',
  ]);

  assert.deepEqual(
    capabilitiesOf(
      microsoftAccount(
        'https://graph.microsoft.com/Mail.ReadWrite https://graph.microsoft.com/Calendars.ReadWrite ' +
          'https://graph.microsoft.com/Chat.ReadWrite',
      ),
    ),
    ['gmail', 'calendar', 'chat'],
    'a Microsoft account must never claim drive, whatever it granted',
  );
});

test('a mixed set of mailboxes splits into the ones that can chat and the ones that cannot', async () => {
  const { splitByCapability } = await import('./service.js');

  const google = googleAccount(ALL_GOOGLE_SCOPES);
  const chatty = { ...microsoftAccount('https://graph.microsoft.com/Chat.ReadWrite'), email: 'a@corp.com' };
  const stale = { ...microsoftAccount('https://graph.microsoft.com/Mail.ReadWrite'), email: 'b@corp.com' };

  const { capable, skipped } = splitByCapability([google, chatty, stale], 'chat');

  assert.deepEqual(capable.map((a) => a.email), ['a@corp.com']);
  assert.equal(skipped.length, 2);

  // The two reasons must read differently: one is permanent, the other is a
  // click away, and an agent that conflates them gives the wrong advice.
  const forGoogle = skipped.find((s) => s.account === 'erik@dibbla.com')!;
  const forStale = skipped.find((s) => s.account === 'b@corp.com')!;
  assert.match(forGoogle.reason, /do not have this capability/);
  assert.match(forStale.reason, /needs its permission extending/);
  assert.match(forStale.reason, /reauth/);
});

/* ------------------------------------------------------------------ *
 * Teams chat: mapping, driven through a stubbed Graph
 * ------------------------------------------------------------------ */

/** A Graph that answers from fixtures, so the mapping can be tested offline. */
function stubGraph(routes: Record<string, unknown>) {
  const find = (path: string) => {
    const key = Object.keys(routes).find((k) => path.startsWith(k));
    if (key === undefined) throw new Error(`stub Graph has no fixture for ${path}`);
    return routes[key];
  };
  return {
    account: {} as never,
    get: async (path: string) => find(path),
    getAll: async (path: string) => (find(path) as { value: unknown[] }).value,
    post: async (path: string) => find(path),
    postNoContent: async () => undefined,
    patch: async (path: string) => find(path),
    del: async () => undefined,
    getBinary: async () => Buffer.alloc(0),
    putRange: async () => new Response(null, { status: 201 }),
  } as never;
}

const AAD = '#microsoft.graph.aadUserConversationMember';

test('a participant from another tenant is flagged external, one from ours is not', async () => {
  const { microsoftChatApi } = await import('./microsoft/chat.js');

  const api = microsoftChatApi(
    stubGraph({
      '/me/chats': {
        value: [
          {
            id: 'chat-external',
            chatType: 'group',
            topic: 'Leverans Q3',
            lastUpdatedDateTime: '2026-08-18T10:00:00Z',
            members: [
              { '@odata.type': AAD, displayName: 'Erik', email: 'erik@corp.com', tenantId: 'T1' },
              { '@odata.type': AAD, displayName: 'Kund', email: 'anna@kund.se', tenantId: 'T2' },
            ],
          },
          {
            id: 'chat-internal',
            chatType: 'oneOnOne',
            lastUpdatedDateTime: '2026-08-17T10:00:00Z',
            members: [
              { '@odata.type': AAD, displayName: 'Erik', email: 'erik@corp.com', tenantId: 'T1' },
              { '@odata.type': AAD, displayName: 'Jon', email: 'jon@corp.com', tenantId: 'T1' },
            ],
          },
        ],
      },
    }),
    'erik@corp.com',
  );

  const [external, internal] = await api.listChats(10);

  assert.equal(external!.id, 'chat-external', 'chats must come back most recent first');
  assert.equal(external!.isExternal, true);
  assert.deepEqual(external!.externalParticipants, ['Kund <anna@kund.se>']);

  assert.equal(internal!.isExternal, false);
  assert.deepEqual(internal!.externalParticipants, []);
  assert.equal(internal!.participants.find((p) => p.isSelf)?.email, 'erik@corp.com');
});

test('a participant whose tenant is unknown counts as external', async () => {
  const { microsoftChatApi } = await import('./microsoft/chat.js');

  const api = microsoftChatApi(
    stubGraph({
      '/me/chats': {
        value: [
          {
            id: 'c',
            chatType: 'meeting',
            members: [
              { '@odata.type': AAD, displayName: 'Erik', email: 'erik@corp.com', tenantId: 'T1' },
              // A federated contact with no tenant reported, and a bot.
              { '@odata.type': AAD, displayName: 'Okänd', email: 'x@elsewhere.com', tenantId: null },
              { '@odata.type': '#microsoft.graph.appConversationMember', displayName: 'Polly' },
            ],
          },
        ],
      },
    }),
    'erik@corp.com',
  );

  const [chat] = await api.listChats(10);
  assert.equal(chat!.isExternal, true);
  assert.deepEqual(chat!.externalParticipants, ['Okänd <x@elsewhere.com>', 'Polly']);
});

test('chat messages are converted to text and returned in reading order', async () => {
  const { microsoftChatApi } = await import('./microsoft/chat.js');

  const api = microsoftChatApi(
    stubGraph({
      '/chats/c/messages': {
        // Graph hands these back newest-first.
        value: [
          {
            id: 'm2',
            messageType: 'message',
            createdDateTime: '2026-08-18T10:05:00Z',
            from: { user: { displayName: 'Anna' } },
            body: { contentType: 'html', content: '<div>Ja, det <b>funkar</b>.</div>' },
            mentions: [{ mentionText: 'Erik' }],
          },
          {
            id: 'm1',
            messageType: 'message',
            createdDateTime: '2026-08-18T10:00:00Z',
            from: { user: { displayName: 'Erik' } },
            body: { contentType: 'html', content: '<div>Hinner du titta p&aring; det?</div>' },
            attachments: [
              { name: 'offert.pdf', contentType: 'application/pdf', contentUrl: 'https://sp/offert.pdf' },
            ],
          },
          {
            id: 'sys',
            messageType: 'systemEventMessage',
            createdDateTime: '2026-08-18T09:59:00Z',
            body: { contentType: 'html', content: '<systemEventMessage/>' },
          },
        ],
      },
    }),
    'erik@corp.com',
  );

  const messages = await api.listMessages('c', 10);

  assert.deepEqual(messages.map((m) => m.id), ['sys', 'm1', 'm2']);
  assert.equal(messages[1]!.bodyText, 'Hinner du titta på det?');
  assert.equal(messages[1]!.bodyIsHtmlFallback, true);
  assert.equal(messages[2]!.bodyText, 'Ja, det funkar.');
  assert.deepEqual(messages[2]!.mentions, ['Erik']);
  // The file is a link, not something the server can fetch.
  assert.equal(messages[1]!.attachments[0]!.url, 'https://sp/offert.pdf');
  assert.equal(messages[0]!.isSystemEvent, true, 'a system event must be distinguishable from speech');
});

test('an empty chat message is refused rather than posted', async () => {
  const { microsoftChatApi } = await import('./microsoft/chat.js');

  const api = microsoftChatApi(stubGraph({}), 'erik@corp.com');
  await assert.rejects(() => api.sendMessage('c', { body: '   ' }), /empty chat message/);
});

test('HTML entities decode, including the ones Swedish mail is full of', async () => {
  const { htmlToText } = await import('./html.js');

  assert.equal(htmlToText('<p>Hinner du titta p&aring; det?</p>'), 'Hinner du titta på det?');
  assert.equal(htmlToText('<div>&#229;&#228;&#246; &#xE5;</div>'), 'åäö å');
  assert.equal(htmlToText('<p>caf&eacute; &mdash; 5&nbsp;kr</p>'), 'café — 5 kr');

  // Decoding in one pass: a literal, escaped entity must survive as written
  // rather than being decoded a second time into a character nobody sent.
  assert.equal(htmlToText('<p>&amp;#229;</p>'), '&#229;');
  assert.equal(htmlToText('<p>&amp;lt;</p>'), '&lt;');

  // An unknown name is more likely to be text than a missed entity.
  assert.equal(htmlToText('<p>R&D;Q</p>'), 'R&D;Q');
});

/* ------------------------------------------------------------------ *
 * Microsoft: folder resolution
 *
 * Regression cover for a bug that took every mail call down: `wellKnownName`
 * exists on mailFolder in the Graph beta endpoint but not in v1.0, and naming
 * an unknown property in $select fails the whole request rather than returning
 * null for it.
 * ------------------------------------------------------------------ */

/**
 * A stub Graph that refuses beta-only properties exactly as v1.0 does, so a
 * request naming one fails the test instead of only failing in production.
 */
function v1OnlyGraph(routes: Record<string, unknown>) {
  const BETA_ONLY = ['wellKnownName', 'isHidden'];

  const answer = (path: string) => {
    for (const property of BETA_ONLY) {
      if (path.includes(property)) {
        throw new Error(
          `Parsing OData Select and Expand failed: Could not find a property named ` +
            `'${property}' on type 'microsoft.graph.mailFolder'`,
        );
      }
    }
    const key = Object.keys(routes).find((k) => path.startsWith(k));
    if (key === undefined) throw new Error(`stub Graph has no fixture for ${path}`);
    return routes[key];
  };

  return {
    account: {} as never,
    get: async (path: string) => answer(path),
    getAll: async (path: string) => (answer(path) as { value: unknown[] }).value,
    post: async (path: string) => answer(path),
    postNoContent: async () => undefined,
    patch: async (path: string) => answer(path),
    del: async () => undefined,
    getBinary: async () => Buffer.alloc(0),
    putRange: async () => new Response(null, { status: 201 }),
  } as never;
}

/** The six well-known folders, as a $batch response with Archive missing. */
const BATCH_FOLDERS = {
  responses: [
    { id: '0', status: 200, body: { id: 'f-inbox' } },
    { id: '1', status: 200, body: { id: 'f-sent' } },
    { id: '2', status: 200, body: { id: 'f-drafts' } },
    { id: '3', status: 200, body: { id: 'f-deleted' } },
    { id: '4', status: 200, body: { id: 'f-junk' } },
    // No Archive folder in this mailbox.
    { id: '5', status: 404, body: {} },
  ],
};

test('listing labels never asks Graph v1.0 for a beta-only property', async () => {
  const { microsoftMailApi } = await import('./microsoft/mail.js');

  const api = microsoftMailApi(
    v1OnlyGraph({
      '/$batch': BATCH_FOLDERS,
      '/me/mailFolders/f-projekt/childFolders': {
        value: [{ id: 'f-2026', displayName: '2026', childFolderCount: 0 }],
      },
      '/me/mailFolders': {
        value: [
          { id: 'f-inbox', displayName: 'Inbox', childFolderCount: 0 },
          { id: 'f-projekt', displayName: 'Projekt', childFolderCount: 1 },
        ],
      },
      '/me/outlook/masterCategories': { value: [{ displayName: 'Kunder' }] },
    }),
    'erik@corp.com',
  );

  const labels = await api.listLabels();
  const byId = new Map(labels.map((l) => [l.id, l]));

  // The Gmail vocabulary is offered whether or not the folder exists, so a
  // caller can always say "archive this" and get a clear answer if it cannot.
  assert.equal(byId.get('INBOX')?.type, 'system');
  assert.equal(byId.get('ARCHIVE')?.type, 'system');

  // A nested folder must be reachable, or it cannot be used as a move target.
  assert.equal(byId.get('f-2026')?.name, '2026');
  assert.equal(byId.get('Kunder')?.type, 'user');

  // Inbox is already listed as INBOX; offering its raw id too would give a
  // caller two ways to name one folder.
  assert.equal(byId.has('f-inbox'), false);
});

test('a KQL search sifts out Junk and Deleted Items itself', async () => {
  const { microsoftMailApi } = await import('./microsoft/mail.js');

  // $search cannot be combined with $filter, so this is the one path that still
  // has to exclude folders after fetching. It over-fetches to compensate.
  const messages = {
    value: [
      { id: 'm1', subject: 'Riktigt', parentFolderId: 'f-inbox', receivedDateTime: '2026-08-18T10:00:00Z', isRead: true },
      { id: 'm2', subject: 'Skräp', parentFolderId: 'f-junk', receivedDateTime: '2026-08-18T11:00:00Z', isRead: true },
      { id: 'm3', subject: 'Raderat', parentFolderId: 'f-deleted', receivedDateTime: '2026-08-18T12:00:00Z', isRead: true },
    ],
  };

  const api = microsoftMailApi(
    v1OnlyGraph({ '/$batch': BATCH_FOLDERS, '/me/messages': messages }),
    'erik@corp.com',
  );

  const clean = await api.searchMessages('faktura', 10, false);
  assert.deepEqual(clean.map((m) => m.subject), ['Riktigt']);

  const everything = await api.searchMessages('faktura', 10, true);
  assert.deepEqual(
    everything.map((m) => m.subject),
    ['Raderat', 'Skräp', 'Riktigt'],
    'includeSpamTrash must keep them, newest first',
  );
});

test('a message carries the Gmail-style labels for where it is and how it is marked', async () => {
  const { microsoftMailApi } = await import('./microsoft/mail.js');

  const api = microsoftMailApi(
    v1OnlyGraph({
      '/$batch': BATCH_FOLDERS,
      '/me/messages': {
        value: [
          {
            id: 'm1',
            subject: 'Hej',
            parentFolderId: 'f-inbox',
            receivedDateTime: '2026-08-18T10:00:00Z',
            isRead: false,
            flag: { flagStatus: 'flagged' },
            categories: ['Kunder'],
          },
        ],
      },
    }),
    'erik@corp.com',
  );

  const [message] = await api.searchMessages('', 10, false);
  assert.deepEqual(message!.labelIds, ['INBOX', 'UNREAD', 'STARRED', 'Kunder']);
  assert.equal(message!.isUnread, true);
});

test('a filtered search always leads with the property it sorts by', async () => {
  const { translateQuery } = await import('./microsoft/query.js');

  // Exchange rejects $orderby=receivedDateTime unless the filter starts with
  // receivedDateTime — verified against a live mailbox, where "is:starred" and
  // "is:unread has:attachment" both failed with "The restriction or sort order
  // is too complex for this operation" until the prefix was added.
  for (const query of ['is:unread has:attachment', 'is:starred', 'has:attachment', 'newer_than:7d']) {
    const t = translateQuery(query);
    assert.equal(t.mode, 'filter', `${query} should not need full-text search`);
    assert.ok(
      t.odataFilter!.startsWith('receivedDateTime ge '),
      `${query} produced a filter Exchange would refuse to sort: ${t.odataFilter}`,
    );
  }

  // An empty query filters on nothing at all, and $orderby alone is accepted;
  // adding a prefix there would be a pointless clause on every listing.
  assert.equal(translateQuery('').odataFilter, null);
});

test('an over-wide calendar range is refused with the limit named', async () => {
  const { microsoftCalendarApi } = await import('./microsoft/calendar.js');

  const api = microsoftCalendarApi(stubGraph({ '/me/calendar/calendarView': { value: [] } }), 'me@corp.com');

  // Graph's own words are "The range between the start and end dates is greater
  // than the allowed range", which reads like a quota rather than an input to fix.
  await assert.rejects(
    () =>
      api.listEvents({
        calendarId: 'primary',
        timeMin: '2020-01-01T00:00:00Z',
        timeMax: '2030-01-01T00:00:00Z',
        maxResults: 10,
      }),
    /1825 days .*five years.*Narrow the range/s,
  );

  // Just inside the limit still goes through to Graph.
  await assert.doesNotReject(() =>
    api.listEvents({
      calendarId: 'primary',
      timeMin: '2026-01-01T00:00:00Z',
      timeMax: '2030-12-01T00:00:00Z',
      maxResults: 10,
    }),
  );
});

test('a write response in a named zone is converted, not stamped with Z', async () => {
  const { toEventSummary } = await import('./microsoft/calendar.js');

  // Reads ask for UTC and get it. A create or patch response comes back in the
  // zone it was submitted in, ignoring the Prefer header — verified live, where
  // a 09:00 Stockholm meeting was reported as 09:00Z, two hours out.
  const written = toEventSummary(
    {
      id: 'e',
      start: { dateTime: '2026-08-19T09:00:00.0000000', timeZone: 'Europe/Stockholm' },
      end: { dateTime: '2026-08-19T09:15:00.0000000', timeZone: 'Europe/Stockholm' },
    },
    'me@corp.com',
  );
  assert.equal(written.start, '2026-08-19T07:00:00.000Z');
  assert.equal(written.end, '2026-08-19T07:15:00.000Z');

  // Winter, when Stockholm is one hour ahead rather than two.
  const winter = toEventSummary(
    { id: 'e', start: { dateTime: '2026-01-15T09:00:00.0000000', timeZone: 'Europe/Stockholm' } },
    'me@corp.com',
  );
  assert.equal(winter.start, '2026-01-15T08:00:00.000Z');

  // The Windows names some tenants still report.
  const windows = toEventSummary(
    { id: 'e', start: { dateTime: '2026-08-19T09:00:00.0000000', timeZone: 'W. Europe Standard Time' } },
    'me@corp.com',
  );
  assert.equal(windows.start, '2026-08-19T07:00:00.000Z');

  // Already UTC, and the ordinary read path, must be untouched.
  const read = toEventSummary(
    { id: 'e', start: { dateTime: '2026-08-19T07:00:00.0000000', timeZone: 'UTC' } },
    'me@corp.com',
  );
  assert.equal(read.start, '2026-08-19T07:00:00.000Z');

  // An unrecognised zone cannot be converted; falling back to the wall clock is
  // no worse than before and never throws.
  const unknown = toEventSummary(
    { id: 'e', start: { dateTime: '2026-08-19T09:00:00.0000000', timeZone: 'Mars/Olympus' } },
    'me@corp.com',
  );
  assert.equal(unknown.start, '2026-08-19T09:00:00.000Z');
});

/* ------------------------------------------------------------------ *
 * Teams chat: starting one
 * ------------------------------------------------------------------ */

test('starting a chat adds you and refuses the shapes Teams rejects', async () => {
  const { microsoftChatApi } = await import('./microsoft/chat.js');

  const posted: unknown[] = [];
  const graph = {
    account: {} as never,
    get: async () => ({
      id: 'new-chat',
      chatType: 'oneOnOne',
      members: [
        { '@odata.type': AAD, displayName: 'Erik', email: 'erik@corp.com', tenantId: 'T1' },
        { '@odata.type': AAD, displayName: 'Jon', email: 'jon@corp.com', tenantId: 'T1' },
      ],
    }),
    getAll: async () => [],
    post: async (_path: string, body: unknown) => {
      posted.push(body);
      return { id: 'new-chat' };
    },
    postNoContent: async () => undefined,
    patch: async () => ({}),
    del: async () => undefined,
    getBinary: async () => Buffer.alloc(0),
    putRange: async () => new Response(null, { status: 201 }),
  } as never;

  const api = microsoftChatApi(graph, 'erik@corp.com');

  const { chat } = await api.createChat(['jon@corp.com']);
  assert.equal(chat.id, 'new-chat');

  const body = posted[0] as { chatType: string; members: Array<Record<string, string>> };
  assert.equal(body.chatType, 'oneOnOne');
  // A chat the account is not a member of is one it could never read again.
  assert.equal(body.members.length, 2);
  assert.ok(body.members.some((m) => m['user@odata.bind']?.includes('erik@corp.com')));

  // Listing yourself must not add you twice, which Graph rejects outright.
  posted.length = 0;
  await api.createChat(['jon@corp.com', 'ERIK@corp.com', 'jon@corp.com']);
  assert.equal((posted[0] as { members: unknown[] }).members.length, 2);

  await assert.rejects(() => api.createChat([]), /at least one other person/);
  await assert.rejects(() => api.createChat(['a@x.com'], 'Projekt'), /cannot be given a topic/);
});

test('several participants make a named group chat', async () => {
  const { microsoftChatApi } = await import('./microsoft/chat.js');

  const posted: unknown[] = [];
  const graph = {
    account: {} as never,
    get: async () => ({ id: 'g', chatType: 'group', topic: 'Projekt', members: [] }),
    getAll: async () => [],
    post: async (_path: string, body: unknown) => {
      posted.push(body);
      return { id: 'g' };
    },
    postNoContent: async () => undefined,
    patch: async () => ({}),
    del: async () => undefined,
    getBinary: async () => Buffer.alloc(0),
    putRange: async () => new Response(null, { status: 201 }),
  } as never;

  const api = microsoftChatApi(graph, 'erik@corp.com');
  const { chat, alreadyExisted } = await api.createChat(['a@x.com', 'b@x.com'], 'Projekt');

  const body = posted[0] as { chatType: string; topic: string; members: unknown[] };
  assert.equal(body.chatType, 'group');
  assert.equal(body.topic, 'Projekt');
  assert.equal(body.members.length, 3);
  assert.equal(chat.topic, 'Projekt');
  // Group chats are never deduplicated by Teams, so this can only ever be false.
  assert.equal(alreadyExisted, false);
});

test('Chat.Create is requested, and chat still only needs Chat.ReadWrite to be usable', async () => {
  const { GRAPH_SCOPES, GRAPH_SCOPE_FOR } = await import('./config.js');
  const { hasCapability } = await import('./oauth/capabilities.js');

  assert.ok((GRAPH_SCOPES as readonly string[]).includes('Chat.Create'));

  // Chat.ReadWrite authorises POST /chats on its own, so an account connected
  // before Chat.Create was requested must not be told it has lost the chat
  // capability.
  assert.equal(GRAPH_SCOPE_FOR.chat, 'Chat.ReadWrite');
  assert.equal(
    hasCapability(microsoftAccount('https://graph.microsoft.com/Chat.ReadWrite'), 'chat'),
    true,
  );
});

test('excluded folders are filtered by the server, not out of the results', async () => {
  const { excludeFolders, translateQuery } = await import('./microsoft/query.js');

  // Dropping them after $top=N lets deleted mail eat the result slots: verified
  // live, where a one-result search returned nothing because the newest message
  // in the mailbox happened to sit in the bin.
  const empty = excludeFolders(translateQuery('').odataFilter, ['f-junk', 'f-trash']);
  assert.equal(
    empty,
    "receivedDateTime ge 1970-01-01T00:00:00Z and parentFolderId ne 'f-junk' " +
      "and parentFolderId ne 'f-trash'",
  );

  // The sort property has to stay at the front whatever else is added.
  const withTerms = excludeFolders(translateQuery('is:unread').odataFilter, ['f-junk']);
  assert.ok(withTerms!.startsWith('receivedDateTime ge '));
  assert.match(withTerms!, /parentFolderId ne 'f-junk'/);
  assert.match(withTerms!, /isRead eq false/);
  // The prefix must appear once, not once per layer that added it.
  assert.equal(withTerms!.split('receivedDateTime ge ').length - 1, 1);

  // Nothing to exclude leaves the filter exactly as translated.
  assert.equal(excludeFolders(null, []), null);
  assert.equal(excludeFolders("isRead eq false", []), 'isRead eq false');

  // A quote in a folder id cannot break out of the literal.
  assert.match(excludeFolders(null, ["a'b"])!, /parentFolderId ne 'a''b'/);
});

test('a search returns real hits even when the newest mail is in the bin', async () => {
  const { microsoftMailApi } = await import('./microsoft/mail.js');

  // The stub answers whatever the server was asked for, so a request that
  // failed to exclude the bin server-side would show up as a binned message.
  const requested: string[] = [];
  const graph = {
    account: {} as never,
    get: async (path: string) => {
      if (path.startsWith('/$batch')) return BATCH_FOLDERS;
      return { value: [] };
    },
    getAll: async (path: string) => {
      requested.push(path);
      return [{ id: 'm1', subject: 'Kvar i inkorgen', parentFolderId: 'f-inbox', receivedDateTime: '2026-08-18T09:00:00Z' }];
    },
    post: async (path: string) => (path === '/$batch' ? BATCH_FOLDERS : {}),
    postNoContent: async () => undefined,
    patch: async () => ({}),
    del: async () => undefined,
    getBinary: async () => Buffer.alloc(0),
    putRange: async () => new Response(null, { status: 201 }),
  } as never;

  const api = microsoftMailApi(graph, 'erik@corp.com');
  const hits = await api.searchMessages('', 1, false);

  assert.equal(hits.length, 1, 'one result asked for, one real result returned');
  assert.match(decodeURIComponent(requested[0]!), /parentFolderId ne 'f-junk'/);
  assert.match(decodeURIComponent(requested[0]!), /parentFolderId ne 'f-deleted'/);

  // includeSpamTrash means no exclusion clause at all.
  requested.length = 0;
  await api.searchMessages('', 1, true);
  assert.doesNotMatch(decodeURIComponent(requested[0]!), /parentFolderId ne/);
});
