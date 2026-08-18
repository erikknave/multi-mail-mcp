import type { Provider } from '../providers.js';

export interface ChatParticipant {
  displayName: string;
  /** Absent for some guest and app members; the display name is then all there is. */
  email: string | null;
  /**
   * True when the participant is outside the connected account's organisation —
   * a guest, a federated contact from another tenant, an app, or a participant
   * whose tenant cannot be determined.
   *
   * Deliberately cautious: the two possible mistakes do not cost the same. A
   * colleague wrongly flagged external makes an agent ask one needless
   * question; an outsider wrongly called internal makes it reply without asking
   * at all.
   */
  isExternal: boolean;
  isSelf: boolean;
}

export interface ChatSummary {
  id: string;
  /** Group chats can be named; one-to-one chats never are. */
  topic: string | null;
  /** oneOnOne | group | meeting */
  chatType: string;
  lastUpdated: string | null;
  webUrl: string | null;
  participants: ChatParticipant[];
  /** True when anyone in the chat is outside the account's own organisation. */
  isExternal: boolean;
  /**
   * Who those people are, so the flag can be checked rather than taken on
   * trust — it matters whether "external" means a known customer or an app.
   */
  externalParticipants: string[];
  /** First line of the most recent message, for recognising a chat at a glance. */
  lastMessagePreview: string | null;
}

export interface ChatAttachmentRef {
  name: string;
  contentType: string | null;
  /**
   * Where the file lives, usually in the sender's OneDrive or a SharePoint site.
   * It is a link to open, not something this server can stream: reading it would
   * need file permissions the server deliberately does not hold for Microsoft
   * accounts.
   */
  url: string | null;
}

export interface ChatMessageSummary {
  id: string;
  chatId: string;
  /** Display name of the sender, or the app name for a bot post. */
  from: string;
  fromEmail: string | null;
  createdAt: string;
  lastEditedAt: string | null;
  bodyText: string;
  /** True when the body arrived as HTML and was converted to text. */
  bodyIsHtmlFallback: boolean;
  /** The @-mentions in the message, as they were written. */
  mentions: string[];
  attachments: ChatAttachmentRef[];
  isDeleted: boolean;
  /** True when this is a system event — someone added, chat renamed, call ended. */
  isSystemEvent: boolean;
}

export interface OutgoingChatMessage {
  /** Plain text. Newlines are preserved when it is sent as HTML. */
  body: string;
  /** Send as HTML instead of plain text, for links and simple formatting. */
  isHtml?: boolean;
}

/**
 * Everything the chat tools need from a messaging account.
 *
 * Only Microsoft implements this. The interface exists anyway so the tools are
 * written against a capability rather than against Graph, and so a second
 * implementation would not mean rewriting them.
 */
export interface ChatApi {
  readonly provider: Provider;
  readonly accountEmail: string;

  listChats(limit: number): Promise<ChatSummary[]>;
  /**
   * Starts a chat with the given people, who are named by email address.
   *
   * One other person makes a one-to-one chat, several make a group chat. The
   * connected account is added automatically — a chat it is not in would be one
   * it could never read.
   */
  createChat(
    participantEmails: string[],
    topic?: string,
  ): Promise<{ chat: ChatSummary; alreadyExisted: boolean }>;
  getChat(chatId: string): Promise<ChatSummary>;
  /** Newest `limit` messages, returned oldest-first so an exchange reads in order. */
  listMessages(chatId: string, limit: number): Promise<ChatMessageSummary[]>;
  sendMessage(
    chatId: string,
    message: OutgoingChatMessage,
  ): Promise<{ id: string; createdAt: string }>;
}
