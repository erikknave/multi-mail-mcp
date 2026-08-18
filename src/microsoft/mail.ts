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
import { ServiceError } from '../serviceError.js';
import type { Graph } from './graph.js';
import { excludeFolders, translateQuery } from './query.js';

/* ------------------------------------------------------------------ *
 * Graph shapes
 * ------------------------------------------------------------------ */

interface GraphRecipient {
  emailAddress?: { name?: string | null; address?: string | null } | null;
}

interface GraphMessage {
  id: string;
  conversationId?: string | null;
  internetMessageId?: string | null;
  subject?: string | null;
  bodyPreview?: string | null;
  body?: { contentType?: string | null; content?: string | null } | null;
  from?: GraphRecipient | null;
  sender?: GraphRecipient | null;
  toRecipients?: GraphRecipient[] | null;
  ccRecipients?: GraphRecipient[] | null;
  bccRecipients?: GraphRecipient[] | null;
  receivedDateTime?: string | null;
  sentDateTime?: string | null;
  isRead?: boolean | null;
  isDraft?: boolean | null;
  hasAttachments?: boolean | null;
  parentFolderId?: string | null;
  categories?: string[] | null;
  flag?: { flagStatus?: string | null } | null;
  internetMessageHeaders?: Array<{ name?: string | null; value?: string | null }> | null;
}

interface GraphFolder {
  id: string;
  displayName?: string | null;
  childFolderCount?: number | null;
}

interface GraphAttachment {
  '@odata.type'?: string;
  id: string;
  name?: string | null;
  contentType?: string | null;
  size?: number | null;
}

/* ------------------------------------------------------------------ *
 * The one vocabulary
 * ------------------------------------------------------------------ */

/**
 * Outlook's well-known folders under the Gmail label names the tools document.
 *
 * Gmail expresses "where a message is" and "what state it is in" as one flat
 * list of labels; Outlook splits it into a folder, two booleans and a category
 * list. Mapping them onto Gmail's names is what lets `modify_labels` mean the
 * same thing in both mailboxes — archive is still "remove INBOX", and marking
 * read is still "remove UNREAD".
 */
const FOLDER_TO_LABEL: Record<string, string> = {
  inbox: 'INBOX',
  sentitems: 'SENT',
  drafts: 'DRAFT',
  deleteditems: 'TRASH',
  junkemail: 'SPAM',
  archive: 'ARCHIVE',
};

const LABEL_TO_FOLDER: Record<string, string> = {
  INBOX: 'inbox',
  SENT: 'sentitems',
  DRAFT: 'drafts',
  TRASH: 'deleteditems',
  SPAM: 'junkemail',
  ARCHIVE: 'archive',
};

const SUMMARY_SELECT =
  'id,conversationId,subject,from,toRecipients,receivedDateTime,sentDateTime,bodyPreview,' +
  'isRead,flag,categories,parentFolderId';

const FULL_SELECT = `${SUMMARY_SELECT},internetMessageId,body,ccRecipients,bccRecipients,` +
  'hasAttachments,isDraft,internetMessageHeaders';

/** Graph rejects inline attachment payloads past ~3 MB; beyond that needs a session. */
const INLINE_ATTACHMENT_LIMIT = 3 * 1024 * 1024;
const UPLOAD_CHUNK_BYTES = 4 * 1024 * 1024;

function formatAddress(r: GraphRecipient | null | undefined): string {
  const address = r?.emailAddress?.address ?? '';
  const name = r?.emailAddress?.name ?? '';
  if (!address) return name;
  return name && name !== address ? `${name} <${address}>` : address;
}

function formatAddresses(list: GraphRecipient[] | null | undefined): string {
  return (list ?? []).map(formatAddress).join(', ');
}

/** Splits `Name <addr>` or a bare address into what Graph wants. */
function toRecipient(value: string): GraphRecipient {
  const m = /^\s*(.*?)\s*<([^>]+)>\s*$/.exec(value);
  if (m) return { emailAddress: { name: m[1] || undefined, address: m[2]! } };
  return { emailAddress: { address: value.trim() } };
}

function headerValue(msg: GraphMessage, name: string): string | null {
  const found = msg.internetMessageHeaders?.find(
    (h) => h.name?.toLowerCase() === name.toLowerCase(),
  );
  return found?.value ?? null;
}

/* ------------------------------------------------------------------ *
 * Implementation
 * ------------------------------------------------------------------ */

export function microsoftMailApi(graph: Graph, accountEmail: string): MailApi {
  /** Well-known folder name -> folder id, resolved once per tool call. */
  let folderCache: Map<string, string> | null = null;
  let allFoldersCache: GraphFolder[] | null = null;

  /**
   * Resolves the well-known folders by asking for each one by name.
   *
   * A `wellKnownName` property does exist on mailFolder — but only in the beta
   * endpoint, and selecting it against v1.0 fails the whole request rather than
   * returning null, which took every mail call down with it. The well-known
   * names do work as path segments in v1.0, so one batched request asks for the
   * six of them by name and keeps this to a single round trip.
   */
  async function wellKnownFolders(): Promise<Map<string, string>> {
    if (folderCache) return folderCache;

    const names = Object.keys(FOLDER_TO_LABEL);
    const res = await graph.post<{
      responses?: Array<{ id?: string; status?: number; body?: { id?: string } }>;
    }>('/$batch', {
      requests: names.map((name, index) => ({
        id: String(index),
        method: 'GET',
        // Batched URLs are relative to the API version root.
        url: `/me/mailFolders/${name}?$select=id`,
      })),
    });

    const map = new Map<string, string>();
    for (const response of res.responses ?? []) {
      const name = names[Number(response.id)];
      // A missing folder answers 404 and is simply absent from the map; not
      // every mailbox has an Archive, and that is not an error until something
      // actually tries to archive.
      if (name && response.status === 200 && response.body?.id) {
        map.set(name, response.body.id);
      }
    }

    folderCache = map;
    return map;
  }

  /**
   * Every folder in the mailbox, including nested ones.
   *
   * /me/mailFolders returns only the top level, so a folder inside a folder
   * would be invisible to list_labels and unusable as a move target. Recursion
   * is driven by childFolderCount, which v1.0 does report.
   */
  async function listAllFolders(): Promise<GraphFolder[]> {
    if (allFoldersCache) return allFoldersCache;

    const collected: GraphFolder[] = [];

    async function walk(path: string, depth: number): Promise<void> {
      // Deep enough for any real filing system; a guard against a cycle or a
      // pathological hierarchy turning one tool call into hundreds of requests.
      if (depth > 4) return;

      const folders = await graph.getAll<GraphFolder>(
        `${path}?$top=100&$select=id,displayName,childFolderCount`,
        200,
      );

      for (const folder of folders) {
        collected.push(folder);
        if ((folder.childFolderCount ?? 0) > 0) {
          await walk(`/me/mailFolders/${encodeURIComponent(folder.id)}/childFolders`, depth + 1);
        }
      }
    }

    await walk('/me/mailFolders', 0);
    allFoldersCache = collected;
    return collected;
  }

  /** Every folder id in the mailbox, so a label can be recognised as a move. */
  async function allFolderIds(): Promise<Set<string>> {
    return new Set((await listAllFolders()).map((f) => f.id));
  }

  /** Folder id -> the Gmail-style label name, for the folders that have one. */
  async function folderLabels(): Promise<Map<string, string>> {
    const wellKnown = await wellKnownFolders();
    const byId = new Map<string, string>();
    for (const [name, id] of wellKnown) {
      const label = FOLDER_TO_LABEL[name];
      if (label) byId.set(id, label);
    }
    return byId;
  }

  function labelsOf(msg: GraphMessage, byFolderId: Map<string, string>): string[] {
    const labels: string[] = [];

    const folderLabel = msg.parentFolderId ? byFolderId.get(msg.parentFolderId) : undefined;
    if (folderLabel) labels.push(folderLabel);
    else if (msg.parentFolderId) labels.push(msg.parentFolderId);

    if (msg.isRead === false) labels.push('UNREAD');
    if (msg.flag?.flagStatus === 'flagged') labels.push('STARRED');
    labels.push(...(msg.categories ?? []));

    return labels;
  }

  function toSummary(msg: GraphMessage, byFolderId: Map<string, string>): MessageSummary {
    const when = msg.receivedDateTime ?? msg.sentDateTime ?? '';
    return {
      id: msg.id,
      threadId: msg.conversationId ?? '',
      from: formatAddress(msg.from ?? msg.sender),
      to: formatAddresses(msg.toRecipients),
      subject: msg.subject ?? '',
      date: when,
      internalDate: when ? Date.parse(when) : 0,
      snippet: msg.bodyPreview ?? '',
      labelIds: labelsOf(msg, byFolderId),
      isUnread: msg.isRead === false,
    };
  }

  function toParsed(
    msg: GraphMessage,
    attachments: AttachmentRef[],
    byFolderId: Map<string, string>,
  ): ParsedMessage {
    const when = msg.receivedDateTime ?? msg.sentDateTime ?? '';
    const isHtml = (msg.body?.contentType ?? '').toLowerCase() === 'html';
    const raw = msg.body?.content ?? '';

    return {
      id: msg.id,
      threadId: msg.conversationId ?? '',
      labelIds: labelsOf(msg, byFolderId),
      snippet: msg.bodyPreview ?? '',
      messageIdHeader: msg.internetMessageId ?? null,
      references: headerValue(msg, 'References'),
      from: formatAddress(msg.from ?? msg.sender),
      to: formatAddresses(msg.toRecipients),
      cc: formatAddresses(msg.ccRecipients),
      bcc: formatAddresses(msg.bccRecipients),
      subject: msg.subject ?? '',
      date: when,
      internalDate: when ? Date.parse(when) : 0,
      bodyText: isHtml ? htmlToText(raw) : raw.trim(),
      bodyIsHtmlFallback: isHtml,
      attachments,
    };
  }

  async function listAttachments(messageId: string): Promise<AttachmentRef[]> {
    const items = await graph.getAll<GraphAttachment>(
      `/me/messages/${encodeURIComponent(messageId)}/attachments?$select=id,name,contentType,size`,
      100,
    );

    // Only file attachments can be streamed by the download route. An embedded
    // mail or a link to a cloud file is a different resource entirely, and
    // listing it as downloadable would produce a link that fails.
    return items
      .filter((a) => (a['@odata.type'] ?? '').includes('fileAttachment'))
      .map((a) => ({
        attachmentId: a.id,
        filename: a.name ?? 'attachment',
        mimeType: a.contentType ?? 'application/octet-stream',
        sizeBytes: a.size ?? 0,
      }));
  }

  /* ---------------------------------------------------------------- *
   * Label changes
   * ---------------------------------------------------------------- */

  interface LabelPlan {
    patch: Record<string, unknown>;
    moveToFolderId: string | null;
    addCategories: string[];
    removeCategories: string[];
  }

  async function planLabelChange(add: string[], remove: string[]): Promise<LabelPlan> {
    const wellKnown = await wellKnownFolders();
    // Only consulted when a label is not one of the system names, so the common
    // case (mark read, archive, star) still costs no extra request.
    const unknownAdds = add.filter(
      (raw) => !LABEL_TO_FOLDER[raw.toUpperCase()] &&
        !['UNREAD', 'READ', 'STARRED', 'IMPORTANT'].includes(raw.toUpperCase()),
    );
    const folderIds = unknownAdds.length ? await allFolderIds() : new Set<string>();
    const plan: LabelPlan = {
      patch: {},
      moveToFolderId: null,
      addCategories: [],
      removeCategories: [],
    };

    const moveTo = (folder: string, label: string) => {
      const id = wellKnown.get(folder);
      if (!id) {
        throw new ServiceError(
          `This mailbox has no ${folder} folder, so "${label}" cannot be applied.`,
        );
      }
      if (plan.moveToFolderId && plan.moveToFolderId !== id) {
        throw new ServiceError(
          'That combination of labels would move the message to two folders at once. ' +
            'A message lives in exactly one Outlook folder — apply one move at a time.',
        );
      }
      plan.moveToFolderId = id;
    };

    for (const raw of add) {
      const label = raw.toUpperCase();
      if (label === 'UNREAD') plan.patch.isRead = false;
      else if (label === 'READ') plan.patch.isRead = true;
      else if (label === 'STARRED' || label === 'IMPORTANT') {
        plan.patch.flag = { flagStatus: 'flagged' };
      } else if (LABEL_TO_FOLDER[label]) moveTo(LABEL_TO_FOLDER[label]!, label);
      else if (folderIds.has(raw)) {
        if (plan.moveToFolderId && plan.moveToFolderId !== raw) {
          throw new ServiceError(
            'That combination of labels would move the message to two folders at once. ' +
              'A message lives in exactly one Outlook folder — apply one move at a time.',
          );
        }
        plan.moveToFolderId = raw;
      } else plan.addCategories.push(raw);
    }

    for (const raw of remove) {
      const label = raw.toUpperCase();
      if (label === 'UNREAD') plan.patch.isRead = true;
      else if (label === 'READ') plan.patch.isRead = false;
      else if (label === 'STARRED' || label === 'IMPORTANT') {
        plan.patch.flag = { flagStatus: 'notFlagged' };
      }
      // Removing the folder a message is in means moving it somewhere else, and
      // the sensible destination differs: out of the inbox is archiving, out of
      // trash or spam is putting it back.
      else if (label === 'INBOX') moveTo('archive', label);
      else if (label === 'TRASH' || label === 'SPAM' || label === 'ARCHIVE') moveTo('inbox', label);
      else plan.removeCategories.push(raw);
    }

    return plan;
  }

  async function applyLabelChange(
    messageId: string,
    add: string[],
    remove: string[],
  ): Promise<GraphMessage> {
    const plan = await planLabelChange(add, remove);
    let current: GraphMessage | null = null;

    if (plan.addCategories.length || plan.removeCategories.length) {
      current = await graph.get<GraphMessage>(
        `/me/messages/${encodeURIComponent(messageId)}?$select=id,categories`,
      );
      const dropped = new Set(plan.removeCategories.map((c) => c.toLowerCase()));
      const next = (current.categories ?? []).filter((c) => !dropped.has(c.toLowerCase()));
      for (const category of plan.addCategories) {
        if (!next.some((c) => c.toLowerCase() === category.toLowerCase())) next.push(category);
      }
      plan.patch.categories = next;
    }

    let result: GraphMessage | null = null;

    if (Object.keys(plan.patch).length > 0) {
      // No $select here: a PATCH answers with the updated resource, and asking
      // it to narrow that is one more thing that can be rejected for no gain.
      result = await graph.patch<GraphMessage>(
        `/me/messages/${encodeURIComponent(messageId)}`,
        plan.patch,
      );
    }

    if (plan.moveToFolderId) {
      // A move mints a new message id, so its response — not the pre-move one —
      // is what describes the message from here on.
      result = await graph.post<GraphMessage>(
        `/me/messages/${encodeURIComponent(result?.id ?? messageId)}/move`,
        { destinationId: plan.moveToFolderId },
      );
    }

    if (!result) {
      result = await graph.get<GraphMessage>(
        `/me/messages/${encodeURIComponent(messageId)}?$select=${SUMMARY_SELECT}`,
      );
    }

    return result;
  }

  /* ---------------------------------------------------------------- *
   * Composing
   * ---------------------------------------------------------------- */

  function draftBody(msg: OutgoingMessage): Record<string, unknown> {
    return {
      subject: msg.subject,
      body: msg.bodyHtml
        ? { contentType: 'html', content: msg.bodyHtml }
        : { contentType: 'text', content: msg.bodyText },
      toRecipients: msg.to.map(toRecipient),
      ...(msg.cc?.length ? { ccRecipients: msg.cc.map(toRecipient) } : {}),
      ...(msg.bcc?.length ? { bccRecipients: msg.bcc.map(toRecipient) } : {}),
    };
  }

  async function attachToDraft(draftId: string, attachment: OutgoingAttachment): Promise<void> {
    if (attachment.content.byteLength <= INLINE_ATTACHMENT_LIMIT) {
      await graph.post(`/me/messages/${encodeURIComponent(draftId)}/attachments`, {
        '@odata.type': '#microsoft.graph.fileAttachment',
        name: attachment.filename,
        contentType: attachment.mimeType,
        contentBytes: attachment.content.toString('base64'),
      });
      return;
    }

    const session = await graph.post<{ uploadUrl: string }>(
      `/me/messages/${encodeURIComponent(draftId)}/attachments/createUploadSession`,
      {
        AttachmentItem: {
          attachmentType: 'file',
          name: attachment.filename,
          size: attachment.content.byteLength,
          contentType: attachment.mimeType,
        },
      },
    );

    const total = attachment.content.byteLength;
    for (let start = 0; start < total; start += UPLOAD_CHUNK_BYTES) {
      const end = Math.min(start + UPLOAD_CHUNK_BYTES, total) - 1;
      const chunk = attachment.content.subarray(start, end + 1);
      const res = await graph.putRange(session.uploadUrl, chunk, start, end, total);
      if (!res.ok && res.status !== 201 && res.status !== 200 && res.status !== 202) {
        throw new ServiceError(
          `Uploading "${attachment.filename}" failed at byte ${start} (HTTP ${res.status}).`,
        );
      }
    }
  }

  /** The message a reply should hang off, so Outlook threads it properly. */
  async function findOriginal(
    inReplyTo: string | undefined,
    threadId: string | undefined,
  ): Promise<string | null> {
    if (inReplyTo) {
      const filter = `internetMessageId eq '${inReplyTo.replace(/'/g, "''")}'`;
      const page = await graph.get<{ value?: GraphMessage[] }>(
        `/me/messages?$filter=${encodeURIComponent(filter)}&$select=id&$top=1`,
      );
      const found = page.value?.[0];
      if (found) return found.id;
    }

    if (threadId) {
      const filter = `conversationId eq '${threadId.replace(/'/g, "''")}'`;
      const page = await graph.get<{ value?: GraphMessage[] }>(
        `/me/messages?$filter=${encodeURIComponent(filter)}&$select=id,receivedDateTime&$top=50`,
      );
      const newest = (page.value ?? []).sort(
        (a, b) =>
          Date.parse(b.receivedDateTime ?? '') - Date.parse(a.receivedDateTime ?? ''),
      )[0];
      if (newest) return newest.id;
    }

    return null;
  }

  /**
   * Builds the draft, replying in place when there is something to reply to.
   *
   * `createReply` is what makes Outlook file the message in the same
   * conversation and set In-Reply-To/References for other clients. Patching it
   * afterwards replaces the quoted-original body Outlook pre-fills, which is
   * correct: the caller supplied the body it wants sent.
   */
  async function buildDraft(msg: OutgoingMessage, threadId?: string): Promise<GraphMessage> {
    const originalId = await findOriginal(msg.inReplyTo, threadId);

    let draft: GraphMessage;
    if (originalId) {
      draft = await graph.post<GraphMessage>(
        `/me/messages/${encodeURIComponent(originalId)}/createReply`,
        {},
      );
      draft = await graph.patch<GraphMessage>(
        `/me/messages/${encodeURIComponent(draft.id)}`,
        draftBody(msg),
      );
    } else {
      draft = await graph.post<GraphMessage>('/me/messages', draftBody(msg));
    }

    for (const attachment of msg.attachments ?? []) {
      await attachToDraft(draft.id, attachment);
    }

    return draft;
  }

  return {
    provider: 'microsoft',
    accountEmail,

    explainQuery(query) {
      const { unsupported } = translateQuery(query);
      return unsupported.map(
        (part) => `Outlook cannot apply "${part}", so that part of the query was ignored.`,
      );
    },

    async searchMessages(query, limit, includeSpamTrash) {
      const translated = translateQuery(query);
      const wellKnown = await wellKnownFolders();
      const byFolderId = await folderLabels();

      const base = translated.folder
        ? `/me/mailFolders/${translated.folder}/messages`
        : '/me/messages';

      const params = new URLSearchParams({ $select: SUMMARY_SELECT });

      // Unlike Gmail, Graph searches every folder by default, so Junk and
      // Deleted Items have to be taken back out to match what the tool promises.
      const excluded =
        !includeSpamTrash && !translated.folder
          ? ([wellKnown.get('junkemail'), wellKnown.get('deleteditems')].filter(
              Boolean,
            ) as string[])
          : [];

      // Relevance ordering under $search means the newest mail is not
      // necessarily in the first page, so ask for more than we need and sort
      // before trimming. Filter mode is already ordered, so it asks for exactly
      // what was requested.
      const wanted =
        translated.mode === 'search' ? Math.min(Math.max(limit * 4, 25), 150) : limit;

      if (translated.mode === 'search' && translated.kql) {
        params.set('$search', `"${translated.kql.replace(/"/g, '\\"')}"`);
      } else {
        const filter = excludeFolders(translated.odataFilter, excluded);
        if (filter) params.set('$filter', filter);
        params.set('$orderby', 'receivedDateTime desc');
      }
      params.set('$top', String(Math.min(wanted, 100)));

      // URLSearchParams encodes a space as "+", which OData reads literally and
      // rejects in "$orderby=receivedDateTime desc". Every genuine plus is
      // already percent-encoded by then, so this only ever fixes spaces.
      const queryString = params.toString().replace(/\+/g, '%20');
      let messages = await graph.getAll<GraphMessage>(`${base}?${queryString}`, wanted);

      if (translated.requireUnread !== null) {
        messages = messages.filter((m) => (m.isRead === false) === translated.requireUnread);
      }
      if (translated.requireFlagged) {
        messages = messages.filter((m) => m.flag?.flagStatus === 'flagged');
      }

      // $search cannot be combined with $filter, so that path still has to sift
      // the folders out here — with the wider fetch above as its cushion.
      if (translated.mode === 'search' && excluded.length > 0) {
        const drop = new Set(excluded);
        messages = messages.filter((m) => !m.parentFolderId || !drop.has(m.parentFolderId));
      }

      return messages
        .map((m) => toSummary(m, byFolderId))
        .sort((a, b) => b.internalDate - a.internalDate)
        .slice(0, limit);
    },

    async getMessage(messageId) {
      const [msg, attachments, byFolderId] = await Promise.all([
        graph.get<GraphMessage>(
          `/me/messages/${encodeURIComponent(messageId)}?$select=${FULL_SELECT}`,
          // Asking for text spares us guessing at HTML that Outlook can convert
          // properly itself.
          { headers: { prefer: 'outlook.body-content-type="text"' } },
        ),
        listAttachments(messageId),
        folderLabels(),
      ]);
      return toParsed(msg, attachments, byFolderId);
    },

    async getThread(threadId) {
      const filter = `conversationId eq '${threadId.replace(/'/g, "''")}'`;
      // $orderby cannot be combined with a filter on a different property here,
      // so the ordering is done after the fetch.
      const messages = await graph.getAll<GraphMessage>(
        `/me/messages?$filter=${encodeURIComponent(filter)}&$select=${FULL_SELECT}&$top=50`,
        100,
        { headers: { prefer: 'outlook.body-content-type="text"' } },
      );

      const byFolderId = await folderLabels();
      const ordered = messages.sort(
        (a, b) =>
          Date.parse(a.receivedDateTime ?? a.sentDateTime ?? '') -
          Date.parse(b.receivedDateTime ?? b.sentDateTime ?? ''),
      );

      const parsed = await Promise.all(
        ordered.map(async (m) =>
          toParsed(m, m.hasAttachments ? await listAttachments(m.id) : [], byFolderId),
        ),
      );

      return { threadId, messages: parsed };
    },

    getAttachment(messageId, attachmentId) {
      return graph.getBinary(
        `/me/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}/$value`,
      );
    },

    async listLabels() {
      const labels: MailLabel[] = Object.values(FOLDER_TO_LABEL).map((name) => ({
        id: name,
        name,
        type: 'system',
      }));
      labels.push({ id: 'UNREAD', name: 'UNREAD', type: 'system' });
      labels.push({ id: 'STARRED', name: 'STARRED', type: 'system' });

      // The well-known folders are already listed above under their Gmail
      // names, so listing them again by id would offer two ways to say the same
      // thing and invite a caller to mix them.
      const wellKnownIds = new Set((await wellKnownFolders()).values());
      for (const folder of await listAllFolders()) {
        if (wellKnownIds.has(folder.id)) continue;
        labels.push({ id: folder.id, name: folder.displayName ?? folder.id, type: 'user' });
      }

      const categories = await graph.getAll<{ displayName?: string | null }>(
        '/me/outlook/masterCategories',
        100,
      );
      for (const category of categories) {
        if (category.displayName) {
          labels.push({ id: category.displayName, name: category.displayName, type: 'user' });
        }
      }

      return labels;
    },

    async modifyMessage(messageId, add, remove) {
      const result = await applyLabelChange(messageId, add, remove);
      return { messageId: result.id, labelIds: labelsOf(result, await folderLabels()) };
    },

    async modifyThread(threadId, add, remove) {
      const filter = `conversationId eq '${threadId.replace(/'/g, "''")}'`;
      const messages = await graph.getAll<GraphMessage>(
        `/me/messages?$filter=${encodeURIComponent(filter)}&$select=id&$top=50`,
        100,
      );
      for (const msg of messages) {
        await applyLabelChange(msg.id, add, remove);
      }
    },

    async send(msg, threadId) {
      const draft = await buildDraft(msg, threadId);
      await graph.postNoContent(`/me/messages/${encodeURIComponent(draft.id)}/send`, undefined);

      const conversationId = draft.conversationId ?? '';

      // Sending re-files the message under a new id in Sent Items. Looking it up
      // is what lets the caller pass a usable messageId to get_message next.
      //
      // It does not appear instantly: a lookup fired the moment /send returns
      // finds nothing, and did exactly that in testing. One retry covers the
      // gap. The mail is sent regardless, so a miss is reported rather than
      // turned into a failure — send() is not the place to keep trying.
      const findSent = async (): Promise<string> => {
        try {
          const filter = `conversationId eq '${conversationId.replace(/'/g, "''")}'`;
          const page = await graph.get<{ value?: GraphMessage[] }>(
            `/me/mailFolders/sentitems/messages?$filter=${encodeURIComponent(filter)}&$select=id,sentDateTime&$top=10`,
          );
          const newest = (page.value ?? []).sort(
            (a, b) => Date.parse(b.sentDateTime ?? '') - Date.parse(a.sentDateTime ?? ''),
          )[0];
          return newest?.id ?? '';
        } catch {
          return '';
        }
      };

      let sentId = '';
      if (conversationId) {
        sentId = await findSent();
        if (!sentId) {
          await new Promise((resolve) => setTimeout(resolve, 1200));
          sentId = await findSent();
        }
      }

      return { id: sentId, threadId: conversationId };
    },

    async createDraft(msg, threadId) {
      const draft = await buildDraft(msg, threadId);
      return { draftId: draft.id, messageId: draft.id };
    },

    async getProfile() {
      const [me, inbox] = await Promise.all([
        graph.get<{ mail?: string | null; userPrincipalName?: string | null }>(
          '/me?$select=mail,userPrincipalName',
        ),
        graph.get<{ totalItemCount?: number | null; unreadItemCount?: number | null }>(
          '/me/mailFolders/inbox?$select=totalItemCount,unreadItemCount',
        ),
      ]);

      return {
        emailAddress: (me.mail ?? me.userPrincipalName ?? accountEmail).toLowerCase(),
        stats: {
          inboxTotal: inbox.totalItemCount ?? 0,
          inboxUnread: inbox.unreadItemCount ?? 0,
        },
      };
    },
  };
}
