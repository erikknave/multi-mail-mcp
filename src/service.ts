import { createWriteStream } from 'node:fs';
import { unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { calendar_v3, docs_v1, drive_v3, gmail_v1, sheets_v4 } from 'googleapis';
import { config } from './config.js';
import { randomId, signToken, verifyToken } from './crypto.js';
import { now } from './db/index.js';
import { accounts, uploads, type Account, type Upload, type User } from './db/repo.js';
import { calendarFor } from './google/calendar.js';
import { docsFor } from './google/docs.js';
import { driveFor } from './google/drive.js';
import { sheetsFor } from './google/sheets.js';
import { gmailFor } from './google/gmail.js';
import {
  buildReauthUrl,
  getAuthorizedClient,
  ReauthRequiredError,
  requireCapability,
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
  requireCapability(account, 'gmail');
  return gmailFor(await getAuthorizedClient(account));
}

export async function calendarClient(account: Account): Promise<calendar_v3.Calendar> {
  requireCapability(account, 'calendar');
  return calendarFor(await getAuthorizedClient(account));
}

export async function driveClient(account: Account): Promise<drive_v3.Drive> {
  // Checked before the call so an account connected before Drive support gets a
  // precise "extend the permission" message instead of an opaque 403.
  requireCapability(account, 'drive');
  return driveFor(await getAuthorizedClient(account));
}

// Sheets and Docs are separate APIs but are authorised by the same Drive scope,
// so no additional consent is involved — only the project-level enablement that
// apiDisabledMessage explains when it is missing.
export async function sheetsClient(account: Account): Promise<sheets_v4.Sheets> {
  requireCapability(account, 'drive');
  return sheetsFor(await getAuthorizedClient(account));
}

export async function docsClient(account: Account): Promise<docs_v1.Docs> {
  requireCapability(account, 'drive');
  return docsFor(await getAuthorizedClient(account));
}

/**
 * Google answers a call to an API that is switched off in the Cloud project
 * with a 403 whose text buries the fix in a wall of prose. Recognise it and
 * return the one action that resolves it, or the agent reports a permission
 * problem the user cannot act on.
 */
export function apiDisabledMessage(err: unknown): string | null {
  const message = (err as { message?: string })?.message ?? String(err);
  if (!/has not been used in project|is disabled|SERVICE_DISABLED/i.test(message)) return null;

  const api = /\b([a-z]+)\.googleapis\.com/i.exec(message)?.[1] ?? 'the required';
  const url = /https:\/\/console\.[^\s]+/.exec(message)?.[0]?.replace(/[.,]$/, '');

  return (
    `The Google ${api} API is not enabled in the Cloud project, so this cannot work yet. ` +
    `This is a one-off project setting, not a permission problem — no account needs to ` +
    `sign in again.\n\n` +
    `Ask the user to open ${url ?? 'the Google Cloud console'} and click Enable, then wait ` +
    `a minute and retry.`
  );
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
 * Signed Drive download URLs
 * ------------------------------------------------------------------ */

interface DriveDownloadPayload extends Record<string, unknown> {
  k: 'dd';
  exp: number;
  uid: string;
  aid: string;
  fid: string;
  fn: string;
  /** Export target for Google-native files; empty for ordinary binaries. */
  ex: string;
}

export function buildDriveDownloadUrl(params: {
  user: User;
  account: Account;
  fileId: string;
  filename: string;
  exportMimeType?: string;
}): { url: string; expiresAt: string } {
  const exp = now() + config.downloadUrlTtl;
  const token = signToken({
    k: 'dd',
    exp,
    uid: params.user.id,
    aid: params.account.id,
    fid: params.fileId,
    fn: params.filename,
    ex: params.exportMimeType ?? '',
  } satisfies DriveDownloadPayload);

  return {
    url: `${config.publicBaseUrl}/files/drive/${token}`,
    expiresAt: new Date(exp * 1000).toISOString(),
  };
}

export function parseDriveDownloadToken(token: string): DriveDownloadPayload | null {
  return verifyToken<DriveDownloadPayload>(token, 'dd');
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
