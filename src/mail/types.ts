import type { Provider } from '../providers.js';

export interface AttachmentRef {
  attachmentId: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
}

export interface ParsedMessage {
  id: string;
  /** Gmail thread id, or Outlook conversationId. Both group one exchange. */
  threadId: string;
  /**
   * Gmail label ids, or for Outlook a synthesised equivalent: the folder id
   * plus the system markers (UNREAD, STARRED, …) that describe the same state.
   * Presenting one vocabulary is what lets an agent treat both mailboxes alike.
   */
  labelIds: string[];
  snippet: string;
  /** RFC 2822 Message-ID header, needed to thread replies correctly. */
  messageIdHeader: string | null;
  references: string | null;
  from: string;
  to: string;
  cc: string;
  bcc: string;
  subject: string;
  date: string;
  /** Unix ms — reliable for sorting across accounts and providers. */
  internalDate: number;
  bodyText: string;
  bodyIsHtmlFallback: boolean;
  attachments: AttachmentRef[];
}

/**
 * The compact shape returned by search — deliberately body-free to save tokens.
 *
 * There is no `hasAttachments` here on purpose. Gmail search fetches messages
 * in `metadata` format, which returns headers but not the MIME part tree, so
 * attachment presence cannot be determined without refetching every hit in
 * full. Filter with the `has:attachment` query operator instead — it runs
 * server-side on both providers and costs nothing.
 */
export interface MessageSummary {
  id: string;
  threadId: string;
  from: string;
  to: string;
  subject: string;
  date: string;
  internalDate: number;
  snippet: string;
  labelIds: string[];
  isUnread: boolean;
}

export interface MailLabel {
  id: string;
  name: string;
  /** 'system' for built-ins, 'user' for folders and categories people made. */
  type: string;
}

export interface OutgoingAttachment {
  filename: string;
  mimeType: string;
  content: Buffer;
}

export interface OutgoingMessage {
  from: string;
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  bodyText: string;
  bodyHtml?: string;
  attachments?: OutgoingAttachment[];
  /** Set both when replying so mail clients thread the message correctly. */
  inReplyTo?: string;
  references?: string;
}

/**
 * Everything the mail tools need from a mailbox, with the provider hidden
 * behind it.
 *
 * The shapes are Gmail's, because that is what the tool descriptions already
 * promise and what agents have learned to expect. The Microsoft implementation
 * translates in both directions rather than exposing a second dialect.
 */
export interface MailApi {
  readonly provider: Provider;
  readonly accountEmail: string;

  searchMessages(query: string, limit: number, includeSpamTrash: boolean): Promise<MessageSummary[]>;
  /**
   * Parts of a query this provider cannot honour, phrased for a human.
   *
   * Search silently ignoring an operator is the failure worth avoiding: an
   * agent would report "no results" for a filter that was never applied. This
   * is answered locally, without a round trip.
   */
  explainQuery(query: string): string[];
  getMessage(messageId: string): Promise<ParsedMessage>;
  getThread(threadId: string): Promise<{ threadId: string; messages: ParsedMessage[] }>;
  getAttachment(messageId: string, attachmentId: string): Promise<Buffer>;
  listLabels(): Promise<MailLabel[]>;
  /**
   * Returns the message's labels after the change, and its id.
   *
   * The id is returned because it can change: Outlook mints a new one when a
   * message moves folder, so "archive it, now read it" would otherwise fail on
   * an id the caller was never told had gone stale. Gmail's ids are unaffected
   * by labelling and come back unchanged.
   */
  modifyMessage(
    messageId: string,
    addLabelIds: string[],
    removeLabelIds: string[],
  ): Promise<{ messageId: string; labelIds: string[] }>;
  modifyThread(threadId: string, addLabelIds: string[], removeLabelIds: string[]): Promise<void>;
  send(msg: OutgoingMessage, threadId?: string): Promise<{ id: string; threadId: string }>;
  createDraft(msg: OutgoingMessage, threadId?: string): Promise<{ draftId: string; messageId: string }>;
  /**
   * A live call that proves the credentials work, plus whatever counts the
   * provider offers. The counts differ (Gmail reports mailbox totals, Graph
   * reports the inbox), so they are a free-form bag rather than a shape that
   * would have to lie about one of them.
   */
  getProfile(): Promise<{ emailAddress: string; stats: Record<string, number> }>;
}
