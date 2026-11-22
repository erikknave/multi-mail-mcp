import type { drive_v3 } from 'googleapis';

/**
 * Comments live in the Drive API, not the Docs API, and are covered by the
 * Drive scope every Google account already grants.
 *
 * What the Drive API cannot do is anchor a new comment to a range of text in a
 * Google Doc: the `anchor` field is an opaque, editor-internal format for Docs,
 * and a comment created through the API appears as a file-level comment. The
 * quoted text is stored and shown with the comment, but nothing in the
 * document is highlighted. Verified against a live document: the created
 * comment comes back with quotedFileContent set and no anchor.
 */

const AUTHOR = 'author(displayName,emailAddress,me)';
const COMMENT_FIELDS =
  `id,content,createdTime,modifiedTime,resolved,deleted,${AUTHOR},quotedFileContent,anchor,` +
  `replies(id,content,action,createdTime,deleted,${AUTHOR})`;

export interface CommentSummary {
  commentId: string;
  author: string;
  content: string;
  createdTime: string | null;
  resolved: boolean;
  quotedText?: string;
  /** False for comments made through the API, which are never attached to text. */
  anchored: boolean;
  replies: Array<{ replyId: string; author: string; content: string; action?: string; createdTime: string | null }>;
}

function who(a: drive_v3.Schema$User | undefined): string {
  if (!a) return 'unknown';
  return a.emailAddress ? `${a.displayName ?? ''} <${a.emailAddress}>`.trim() : (a.displayName ?? 'unknown');
}

export function toCommentSummary(c: drive_v3.Schema$Comment): CommentSummary {
  return {
    commentId: c.id ?? '',
    author: who(c.author),
    content: c.content ?? '',
    createdTime: c.createdTime ?? null,
    resolved: !!c.resolved,
    ...(c.quotedFileContent?.value ? { quotedText: c.quotedFileContent.value } : {}),
    anchored: !!c.anchor,
    replies: (c.replies ?? [])
      .filter((r) => !r.deleted)
      .map((r) => ({
        replyId: r.id ?? '',
        author: who(r.author),
        content: r.content ?? '',
        ...(r.action ? { action: r.action } : {}),
        createdTime: r.createdTime ?? null,
      })),
  };
}

export async function listComments(
  drive: drive_v3.Drive,
  fileId: string,
  includeResolved: boolean,
  limit: number,
): Promise<{ comments: CommentSummary[]; more: boolean }> {
  const out: CommentSummary[] = [];
  let pageToken: string | undefined;
  do {
    const res = await drive.comments.list({
      fileId,
      pageSize: 100,
      pageToken,
      includeDeleted: false,
      fields: `nextPageToken,comments(${COMMENT_FIELDS})`,
    });
    for (const c of res.data.comments ?? []) {
      if (c.deleted) continue;
      if (!includeResolved && c.resolved) continue;
      out.push(toCommentSummary(c));
    }
    pageToken = res.data.nextPageToken ?? undefined;
  } while (pageToken && out.length < limit);
  return { comments: out.slice(0, limit), more: out.length > limit || !!pageToken };
}

export async function addComment(
  drive: drive_v3.Drive,
  fileId: string,
  content: string,
  quotedText?: string,
): Promise<CommentSummary> {
  const res = await drive.comments.create({
    fileId,
    fields: COMMENT_FIELDS,
    requestBody: {
      content,
      ...(quotedText ? { quotedFileContent: { mimeType: 'text/plain', value: quotedText } } : {}),
    },
  });
  return toCommentSummary(res.data);
}

export async function replyToComment(
  drive: drive_v3.Drive,
  fileId: string,
  commentId: string,
  content: string,
  action?: 'resolve' | 'reopen',
): Promise<{ replyId: string; action?: string }> {
  const res = await drive.replies.create({
    fileId,
    commentId,
    fields: 'id,action',
    requestBody: { content, ...(action ? { action } : {}) },
  });
  return { replyId: res.data.id ?? '', ...(res.data.action ? { action: res.data.action } : {}) };
}
