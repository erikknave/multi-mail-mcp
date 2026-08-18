import { google, type gmail_v1 } from 'googleapis';
import type { OAuth2Client } from 'google-auth-library';
import { htmlToText } from '../html.js';
import type {
  AttachmentRef,
  MailApi,
  MailLabel,
  MessageSummary,
  OutgoingAttachment,
  OutgoingMessage,
  ParsedMessage,
} from '../mail/types.js';

export type {
  AttachmentRef,
  MailLabel,
  MessageSummary,
  OutgoingAttachment,
  OutgoingMessage,
  ParsedMessage,
};

export function gmailFor(auth: OAuth2Client): gmail_v1.Gmail {
  return google.gmail({ version: 'v1', auth });
}

/* ------------------------------------------------------------------ *
 * Payload parsing
 * ------------------------------------------------------------------ */

function header(payload: gmail_v1.Schema$MessagePart | undefined, name: string): string {
  const h = payload?.headers?.find((x) => x.name?.toLowerCase() === name.toLowerCase());
  return h?.value ?? '';
}

function decodeBody(data: string | null | undefined): string {
  if (!data) return '';
  return Buffer.from(data, 'base64url').toString('utf8');
}

interface Walked {
  text: string;
  html: string;
  attachments: AttachmentRef[];
}

function walkParts(part: gmail_v1.Schema$MessagePart | undefined, acc: Walked): void {
  if (!part) return;

  const mime = part.mimeType ?? '';
  const filename = part.filename ?? '';
  const attachmentId = part.body?.attachmentId;

  if (attachmentId && filename) {
    acc.attachments.push({
      attachmentId,
      filename,
      mimeType: mime || 'application/octet-stream',
      sizeBytes: part.body?.size ?? 0,
    });
  } else if (mime === 'text/plain') {
    acc.text += decodeBody(part.body?.data);
  } else if (mime === 'text/html') {
    acc.html += decodeBody(part.body?.data);
  }

  for (const child of part.parts ?? []) walkParts(child, acc);
}

export function parseMessage(msg: gmail_v1.Schema$Message): ParsedMessage {
  const acc: Walked = { text: '', html: '', attachments: [] };
  walkParts(msg.payload, acc);

  const usedHtmlFallback = acc.text.trim() === '' && acc.html.trim() !== '';
  const bodyText = usedHtmlFallback ? htmlToText(acc.html) : acc.text.trim();

  return {
    id: msg.id ?? '',
    threadId: msg.threadId ?? '',
    labelIds: msg.labelIds ?? [],
    snippet: msg.snippet ?? '',
    messageIdHeader: header(msg.payload, 'Message-ID') || null,
    references: header(msg.payload, 'References') || null,
    from: header(msg.payload, 'From'),
    to: header(msg.payload, 'To'),
    cc: header(msg.payload, 'Cc'),
    bcc: header(msg.payload, 'Bcc'),
    subject: header(msg.payload, 'Subject'),
    date: header(msg.payload, 'Date'),
    internalDate: msg.internalDate ? Number(msg.internalDate) : 0,
    bodyText,
    bodyIsHtmlFallback: usedHtmlFallback,
    attachments: acc.attachments,
  };
}

export function summarize(msg: gmail_v1.Schema$Message): MessageSummary {
  const labels = msg.labelIds ?? [];
  return {
    id: msg.id ?? '',
    threadId: msg.threadId ?? '',
    from: header(msg.payload, 'From'),
    to: header(msg.payload, 'To'),
    subject: header(msg.payload, 'Subject'),
    date: header(msg.payload, 'Date'),
    internalDate: msg.internalDate ? Number(msg.internalDate) : 0,
    snippet: msg.snippet ?? '',
    labelIds: labels,
    isUnread: labels.includes('UNREAD'),
  };
}

/* ------------------------------------------------------------------ *
 * Operations
 * ------------------------------------------------------------------ */

export async function searchMessages(
  gmail: gmail_v1.Gmail,
  query: string,
  maxResults: number,
  includeSpamTrash = false,
): Promise<MessageSummary[]> {
  const list = await gmail.users.messages.list({
    userId: 'me',
    q: query || undefined,
    maxResults,
    includeSpamTrash,
  });

  const ids = (list.data.messages ?? []).map((m) => m.id).filter((id): id is string => !!id);
  if (ids.length === 0) return [];

  // metadata format keeps the response small; we only need headers here.
  const details = await Promise.all(
    ids.map((id) =>
      gmail.users.messages.get({
        userId: 'me',
        id,
        format: 'metadata',
        metadataHeaders: ['From', 'To', 'Subject', 'Date'],
      }),
    ),
  );

  return details.map((r) => summarize(r.data));
}

export async function getFullMessage(
  gmail: gmail_v1.Gmail,
  messageId: string,
): Promise<ParsedMessage> {
  const res = await gmail.users.messages.get({ userId: 'me', id: messageId, format: 'full' });
  return parseMessage(res.data);
}

export async function getThread(
  gmail: gmail_v1.Gmail,
  threadId: string,
): Promise<{ threadId: string; messages: ParsedMessage[] }> {
  const res = await gmail.users.threads.get({ userId: 'me', id: threadId, format: 'full' });
  return {
    threadId,
    messages: (res.data.messages ?? []).map(parseMessage),
  };
}

export async function getAttachment(
  gmail: gmail_v1.Gmail,
  messageId: string,
  attachmentId: string,
): Promise<Buffer> {
  const res = await gmail.users.messages.attachments.get({
    userId: 'me',
    messageId,
    id: attachmentId,
  });
  if (!res.data.data) throw new Error('Attachment had no data');
  return Buffer.from(res.data.data, 'base64url');
}

export async function listLabels(gmail: gmail_v1.Gmail): Promise<MailLabel[]> {
  const res = await gmail.users.labels.list({ userId: 'me' });
  return (res.data.labels ?? []).map((l) => ({
    id: l.id ?? '',
    name: l.name ?? '',
    type: l.type ?? 'user',
  }));
}

export async function modifyMessage(
  gmail: gmail_v1.Gmail,
  messageId: string,
  addLabelIds: string[],
  removeLabelIds: string[],
): Promise<string[]> {
  const res = await gmail.users.messages.modify({
    userId: 'me',
    id: messageId,
    requestBody: { addLabelIds, removeLabelIds },
  });
  return res.data.labelIds ?? [];
}

export async function modifyThread(
  gmail: gmail_v1.Gmail,
  threadId: string,
  addLabelIds: string[],
  removeLabelIds: string[],
): Promise<void> {
  await gmail.users.threads.modify({
    userId: 'me',
    id: threadId,
    requestBody: { addLabelIds, removeLabelIds },
  });
}

/* ------------------------------------------------------------------ *
 * Outgoing mail (MIME assembly)
 * ------------------------------------------------------------------ */

/** RFC 2047 encoded-word, so non-ASCII subjects and filenames survive. */
function encodeHeaderValue(value: string): string {
  // eslint-disable-next-line no-control-regex
  if (/^[\x20-\x7E]*$/.test(value)) return value;
  return `=?UTF-8?B?${Buffer.from(value, 'utf8').toString('base64')}?=`;
}

function foldBase64(b64: string): string {
  return b64.replace(/(.{76})/g, '$1\r\n');
}

export function buildMimeMessage(msg: OutgoingMessage): string {
  const boundaryMixed = `mixed_${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
  const boundaryAlt = `alt_${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;

  const headers: string[] = [
    `From: ${msg.from}`,
    `To: ${msg.to.join(', ')}`,
  ];
  if (msg.cc?.length) headers.push(`Cc: ${msg.cc.join(', ')}`);
  if (msg.bcc?.length) headers.push(`Bcc: ${msg.bcc.join(', ')}`);
  headers.push(`Subject: ${encodeHeaderValue(msg.subject)}`);
  if (msg.inReplyTo) headers.push(`In-Reply-To: ${msg.inReplyTo}`);
  if (msg.references) headers.push(`References: ${msg.references}`);
  headers.push('MIME-Version: 1.0');

  const hasAttachments = (msg.attachments?.length ?? 0) > 0;
  const hasHtml = !!msg.bodyHtml;

  const bodyPart = (): string => {
    const textPart =
      'Content-Type: text/plain; charset="UTF-8"\r\n' +
      'Content-Transfer-Encoding: base64\r\n\r\n' +
      foldBase64(Buffer.from(msg.bodyText, 'utf8').toString('base64'));

    if (!hasHtml) return textPart;

    const htmlPart =
      'Content-Type: text/html; charset="UTF-8"\r\n' +
      'Content-Transfer-Encoding: base64\r\n\r\n' +
      foldBase64(Buffer.from(msg.bodyHtml!, 'utf8').toString('base64'));

    return (
      `Content-Type: multipart/alternative; boundary="${boundaryAlt}"\r\n\r\n` +
      `--${boundaryAlt}\r\n${textPart}\r\n` +
      `--${boundaryAlt}\r\n${htmlPart}\r\n` +
      `--${boundaryAlt}--`
    );
  };

  if (!hasAttachments) {
    return `${headers.join('\r\n')}\r\n${bodyPart()}`;
  }

  const parts: string[] = [
    `${headers.join('\r\n')}\r\n` +
      `Content-Type: multipart/mixed; boundary="${boundaryMixed}"\r\n\r\n` +
      `--${boundaryMixed}\r\n${bodyPart()}`,
  ];

  for (const att of msg.attachments ?? []) {
    parts.push(
      `--${boundaryMixed}\r\n` +
        `Content-Type: ${att.mimeType}; name="${encodeHeaderValue(att.filename)}"\r\n` +
        `Content-Disposition: attachment; filename="${encodeHeaderValue(att.filename)}"\r\n` +
        `Content-Transfer-Encoding: base64\r\n\r\n` +
        foldBase64(att.content.toString('base64')),
    );
  }

  parts.push(`--${boundaryMixed}--`);
  return parts.join('\r\n');
}

export async function sendMessage(
  gmail: gmail_v1.Gmail,
  msg: OutgoingMessage,
  threadId?: string,
): Promise<{ id: string; threadId: string }> {
  const raw = Buffer.from(buildMimeMessage(msg), 'utf8').toString('base64url');
  const res = await gmail.users.messages.send({
    userId: 'me',
    requestBody: { raw, ...(threadId ? { threadId } : {}) },
  });
  return { id: res.data.id ?? '', threadId: res.data.threadId ?? '' };
}

export async function createDraft(
  gmail: gmail_v1.Gmail,
  msg: OutgoingMessage,
  threadId?: string,
): Promise<{ draftId: string; messageId: string }> {
  const raw = Buffer.from(buildMimeMessage(msg), 'utf8').toString('base64url');
  const res = await gmail.users.drafts.create({
    userId: 'me',
    requestBody: { message: { raw, ...(threadId ? { threadId } : {}) } },
  });
  return { draftId: res.data.id ?? '', messageId: res.data.message?.id ?? '' };
}

export async function getProfile(
  gmail: gmail_v1.Gmail,
): Promise<{ emailAddress: string; messagesTotal: number; threadsTotal: number }> {
  const res = await gmail.users.getProfile({ userId: 'me' });
  return {
    emailAddress: res.data.emailAddress ?? '',
    messagesTotal: res.data.messagesTotal ?? 0,
    threadsTotal: res.data.threadsTotal ?? 0,
  };
}

/* ------------------------------------------------------------------ *
 * Provider adapter
 * ------------------------------------------------------------------ */

/** Presents a Gmail client through the provider-neutral interface. */
export function googleMailApi(gmail: gmail_v1.Gmail, accountEmail: string): MailApi {
  return {
    provider: 'google',
    accountEmail,
    searchMessages: (query, limit, includeSpamTrash) =>
      searchMessages(gmail, query, limit, includeSpamTrash),
    // Gmail's own syntax, handed straight to Gmail: nothing is lost in translation.
    explainQuery: () => [],
    getMessage: (messageId) => getFullMessage(gmail, messageId),
    getThread: (threadId) => getThread(gmail, threadId),
    getAttachment: (messageId, attachmentId) => getAttachment(gmail, messageId, attachmentId),
    listLabels: () => listLabels(gmail),
    async modifyMessage(messageId, add, remove) {
      // Gmail ids survive labelling, so the id the caller passed is still good.
      return { messageId, labelIds: await modifyMessage(gmail, messageId, add, remove) };
    },
    modifyThread: (threadId, add, remove) => modifyThread(gmail, threadId, add, remove),
    send: (msg, threadId) => sendMessage(gmail, msg, threadId),
    createDraft: (msg, threadId) => createDraft(gmail, msg, threadId),
    async getProfile() {
      const profile = await getProfile(gmail);
      return {
        emailAddress: profile.emailAddress,
        stats: { messagesTotal: profile.messagesTotal, threadsTotal: profile.threadsTotal },
      };
    },
  };
}
