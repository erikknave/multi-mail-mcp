import { createWriteStream } from 'node:fs';
import { unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { calendar_v3, gmail_v1 } from 'googleapis';
import { config } from './config.js';
import { randomId, signToken, verifyToken } from './crypto.js';
import { now } from './db/index.js';
import { accounts, uploads, type Account, type Upload, type User } from './db/repo.js';
import { calendarFor } from './google/calendar.js';
import { gmailFor } from './google/gmail.js';
import {
  buildReauthUrl,
  getAuthorizedClient,
  ReauthRequiredError,
  rethrowAsReauthIfNeeded,
} from './google/oauth.js';

/** A user-facing problem that should be reported verbatim, not as a stack trace. */
export class ServiceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ServiceError';
  }
}

/* ------------------------------------------------------------------ *
 * Account resolution
 * ------------------------------------------------------------------ */

export function listAccounts(user: User): Account[] {
  return accounts.forUser(user.id);
}

/**
 * Finds one of the user's mailboxes by address.
 *
 * When `email` is omitted and the user has exactly one mailbox we use it, so
 * single-account callers never have to name it. With several mailboxes we
 * refuse rather than guess — sending mail from the wrong address is not an
 * error worth being clever about.
 */
export function resolveAccount(user: User, email?: string): Account {
  const all = accounts.forUser(user.id);

  if (all.length === 0) {
    throw new ServiceError(
      `No Google accounts are connected yet. Open ${config.publicBaseUrl}/ and connect a mailbox first.`,
    );
  }

  if (!email) {
    if (all.length === 1) return all[0]!;
    throw new ServiceError(
      `Several mailboxes are connected (${all.map((a) => a.email).join(', ')}). ` +
        `Specify which one to use with the "account" argument.`,
    );
  }

  const normalized = email.toLowerCase().trim();
  const found = all.find((a) => a.email === normalized);
  if (!found) {
    throw new ServiceError(
      `"${email}" is not a connected mailbox. Available: ${all.map((a) => a.email).join(', ')}.`,
    );
  }
  return found;
}

/** Resolves several mailboxes at once; omitted `emails` means "all of them". */
export function resolveAccounts(user: User, emails?: string[]): Account[] {
  const all = accounts.forUser(user.id);
  if (all.length === 0) {
    throw new ServiceError(
      `No Google accounts are connected yet. Open ${config.publicBaseUrl}/ and connect a mailbox first.`,
    );
  }
  if (!emails || emails.length === 0) return all;

  return emails.map((email) => resolveAccount(user, email));
}

export async function gmailClient(account: Account): Promise<gmail_v1.Gmail> {
  return gmailFor(await getAuthorizedClient(account));
}

export async function calendarClient(account: Account): Promise<calendar_v3.Calendar> {
  return calendarFor(await getAuthorizedClient(account));
}

/**
 * Runs a Google call with uniform auth-failure handling, so any expired grant
 * surfaces as a ReauthRequiredError carrying a clickable link rather than an
 * opaque 401 from deep inside googleapis.
 */
export async function withAccount<T>(
  account: Account,
  fn: (auth: Awaited<ReturnType<typeof getAuthorizedClient>>) => Promise<T>,
): Promise<T> {
  const auth = await getAuthorizedClient(account);
  try {
    return await fn(auth);
  } catch (err) {
    if (err instanceof ReauthRequiredError) throw err;
    rethrowAsReauthIfNeeded(err, account);
  }
}

/** Per-account status, including a re-auth link for any mailbox that needs one. */
export function accountStatus(account: Account): {
  email: string;
  displayName: string | null;
  status: string;
  lastError: string | null;
  lastOkAt: string | null;
  reauthUrl?: string;
} {
  return {
    email: account.email,
    displayName: account.display_name,
    status: account.status,
    lastError: account.last_error,
    lastOkAt: account.last_ok_at ? new Date(account.last_ok_at * 1000).toISOString() : null,
    ...(account.status === 'needs_reauth' ? { reauthUrl: buildReauthUrl(account) } : {}),
  };
}

/* ------------------------------------------------------------------ *
 * Signed attachment download URLs
 * ------------------------------------------------------------------ */

interface DownloadPayload extends Record<string, unknown> {
  k: 'dl';
  exp: number;
  uid: string;
  aid: string;
  mid: string;
  att: string;
  fn: string;
  mt: string;
}

export function buildDownloadUrl(params: {
  user: User;
  account: Account;
  messageId: string;
  attachmentId: string;
  filename: string;
  mimeType: string;
}): { url: string; expiresAt: string } {
  const exp = now() + config.downloadUrlTtl;
  const token = signToken({
    k: 'dl',
    exp,
    uid: params.user.id,
    aid: params.account.id,
    mid: params.messageId,
    att: params.attachmentId,
    fn: params.filename,
    mt: params.mimeType,
  } satisfies DownloadPayload);

  return {
    url: `${config.publicBaseUrl}/files/attachment/${token}`,
    expiresAt: new Date(exp * 1000).toISOString(),
  };
}

export function parseDownloadToken(token: string): DownloadPayload | null {
  return verifyToken<DownloadPayload>(token, 'dl');
}

/* ------------------------------------------------------------------ *
 * Signed upload URLs
 * ------------------------------------------------------------------ */

interface UploadPayload extends Record<string, unknown> {
  k: 'ul';
  exp: number;
  uid: string;
  up: string;
}

/** Strips any directory component so a hostile filename can't escape the store. */
export function safeFilename(name: string): string {
  const base = name.split(/[/\\]/).pop() ?? 'file';
  const cleaned = base.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  return cleaned === '' || cleaned === '.' || cleaned === '..' ? 'file' : cleaned.slice(0, 200);
}

export function createUploadSlot(
  user: User,
  filename: string,
  mimeType: string,
): { upload: Upload; url: string; expiresAt: string } {
  const exp = now() + config.uploadUrlTtl;
  const clean = safeFilename(filename);
  // Storage name is random; the display name lives in the database only, so a
  // crafted filename can never influence the path we write to.
  const storagePath = join(config.dataDir, 'uploads', `${randomId(24)}.bin`);

  const upload = uploads.create({
    userId: user.id,
    filename: clean,
    mimeType: mimeType || 'application/octet-stream',
    path: storagePath,
    expiresAt: exp,
  });

  const token = signToken({ k: 'ul', exp, uid: user.id, up: upload.id } satisfies UploadPayload);

  return {
    upload,
    url: `${config.publicBaseUrl}/files/upload/${token}`,
    expiresAt: new Date(exp * 1000).toISOString(),
  };
}

export function parseUploadToken(token: string): UploadPayload | null {
  return verifyToken<UploadPayload>(token, 'ul');
}

/** Streams a request body to the upload's storage path, enforcing the size cap. */
export async function storeUpload(upload: Upload, body: ReadableStream<Uint8Array>): Promise<number> {
  let written = 0;
  const limiter = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      written += chunk.byteLength;
      if (written > config.maxUploadBytes) {
        controller.error(
          new ServiceError(
            `Upload exceeds the ${Math.floor(config.maxUploadBytes / 1024 / 1024)} MB limit.`,
          ),
        );
        return;
      }
      controller.enqueue(chunk);
    },
  });

  try {
    await pipeline(
      Readable.fromWeb(body.pipeThrough(limiter) as Parameters<typeof Readable.fromWeb>[0]),
      createWriteStream(upload.path),
    );
  } catch (err) {
    await unlink(upload.path).catch(() => {});
    throw err;
  }

  uploads.markUploaded(upload.id, written);
  return written;
}

export function listUploads(user: User): Upload[] {
  return uploads.forUser(user.id).filter((u) => u.expires_at > now());
}

export function getReadyUpload(user: User, uploadId: string): Upload {
  const upload = uploads.byId(uploadId);
  if (!upload || upload.user_id !== user.id) {
    throw new ServiceError(`Unknown upload id "${uploadId}".`);
  }
  if (upload.uploaded_at === null) {
    throw new ServiceError(
      `Upload "${uploadId}" was reserved but no file has been PUT to its URL yet.`,
    );
  }
  if (upload.expires_at < now()) {
    throw new ServiceError(`Upload "${uploadId}" has expired. Create a new upload URL.`);
  }
  return upload;
}

/** Deletes expired staged files from disk and their rows. Runs on a timer. */
export async function purgeExpiredUploads(): Promise<number> {
  const stale = uploads.expired();
  for (const upload of stale) {
    await unlink(upload.path).catch(() => {});
    uploads.delete(upload.id);
  }
  return stale.length;
}
