/**
 * Unit tests for the pure logic — MIME assembly, token signing, payload parsing
 * and filename handling. Anything that talks to Google is verified by hand
 * against a live account instead, since it needs real credentials.
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
