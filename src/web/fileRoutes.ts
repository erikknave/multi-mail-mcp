import { createReadStream } from 'node:fs';
import { Hono } from 'hono';
import { accounts, uploads, users } from '../db/repo.js';
import { extensionForExport, getFileBytes, getFileMetadata } from '../google/drive.js';
import {
  driveClient,
  mailApi,
  parseDownloadToken,
  parseDriveDownloadToken,
  parseUploadToken,
  ServiceError,
  storeUpload,
} from '../service.js';

export const fileRoutes = new Hono();

/**
 * Streams an attachment straight from the mailbox it lives in, Gmail or
 * Outlook. Nothing is cached on disk, so the only thing that grants access is
 * the signed token in the path.
 */
fileRoutes.get('/files/attachment/:token', async (c) => {
  const payload = parseDownloadToken(c.req.param('token'));
  if (!payload) return c.text('This download link has expired or is invalid.', 403);

  const user = users.byId(payload.uid);
  const account = accounts.byId(payload.aid);
  if (!user || !account || account.user_id !== user.id) {
    return c.text('This download link is no longer valid.', 404);
  }

  try {
    const api = await mailApi(account);
    const data = await api.getAttachment(payload.mid, payload.att);

    // filename* uses RFC 5987 so non-ASCII names survive; the plain filename is
    // an ASCII-safe fallback for older clients.
    const asciiName = payload.fn.replace(/[^\x20-\x7e]/g, '_').replace(/"/g, '');
    return new Response(new Uint8Array(data), {
      headers: {
        'content-type': payload.mt || 'application/octet-stream',
        'content-length': String(data.byteLength),
        'content-disposition':
          `attachment; filename="${asciiName}"; ` +
          `filename*=UTF-8''${encodeURIComponent(payload.fn)}`,
        'cache-control': 'private, no-store',
      },
    });
  } catch (err) {
    return c.text(`Could not fetch the attachment: ${(err as Error).message}`, 502);
  }
});

/** Receives the file body for a slot created by the create_upload_url tool. */
fileRoutes.put('/files/upload/:token', async (c) => {
  const payload = parseUploadToken(c.req.param('token'));
  if (!payload) return c.text('This upload link has expired or is invalid.', 403);

  const upload = uploads.byId(payload.up);
  if (!upload || upload.user_id !== payload.uid) {
    return c.text('This upload slot no longer exists.', 404);
  }
  if (upload.uploaded_at !== null) {
    return c.text('A file has already been uploaded to this slot. Create a new one.', 409);
  }

  const body = c.req.raw.body;
  if (!body) return c.text('Request had no body.', 400);

  try {
    const size = await storeUpload(upload, body);
    return c.json({
      ok: true,
      uploadId: upload.id,
      filename: upload.filename,
      sizeBytes: size,
      nextStep: 'Pass this uploadId to send_message or create_draft.',
    });
  } catch (err) {
    if (err instanceof ServiceError) return c.text(err.message, 413);
    return c.text(`Upload failed: ${(err as Error).message}`, 500);
  }
});

/** Lets a user verify what actually landed in a slot. */
fileRoutes.get('/files/upload/:token', async (c) => {
  const payload = parseUploadToken(c.req.param('token'));
  if (!payload) return c.text('This link has expired or is invalid.', 403);

  const upload = uploads.byId(payload.up);
  if (!upload || upload.user_id !== payload.uid) return c.text('Unknown upload slot.', 404);
  if (upload.uploaded_at === null) return c.text('Nothing has been uploaded to this slot yet.', 404);

  const asciiName = upload.filename.replace(/[^\x20-\x7e]/g, '_').replace(/"/g, '');
  return new Response(createReadStream(upload.path) as unknown as ReadableStream, {
    headers: {
      'content-type': upload.mime_type,
      'content-disposition': `attachment; filename="${asciiName}"`,
      'cache-control': 'private, no-store',
    },
  });
});

/**
 * Streams a Drive file, exporting Google-native formats on the way. Like the
 * attachment route, nothing is cached: the signed token in the path is the only
 * thing granting access.
 */
fileRoutes.get('/files/drive/:token', async (c) => {
  const payload = parseDriveDownloadToken(c.req.param('token'));
  if (!payload) return c.text('This download link has expired or is invalid.', 403);

  const user = users.byId(payload.uid);
  const account = accounts.byId(payload.aid);
  if (!user || !account || account.user_id !== user.id) {
    return c.text('This download link is no longer valid.', 404);
  }

  try {
    const drive = await driveClient(account);
    const meta = await getFileMetadata(drive, payload.fid);
    const { data, contentType, exported } = await getFileBytes(
      drive,
      meta,
      payload.ex || undefined,
    );

    // An exported Google Doc arrives as .docx/.csv/…, so the stored name needs
    // the matching extension or the file lands unopenable on the user's disk.
    const filename =
      exported && !payload.fn.includes('.')
        ? `${payload.fn}${extensionForExport(contentType)}`
        : payload.fn;

    const asciiName = filename.replace(/[^\x20-\x7e]/g, '_').replace(/"/g, '');
    return new Response(new Uint8Array(data), {
      headers: {
        'content-type': contentType,
        'content-length': String(data.byteLength),
        'content-disposition':
          `attachment; filename="${asciiName}"; ` +
          `filename*=UTF-8''${encodeURIComponent(filename)}`,
        'cache-control': 'private, no-store',
      },
    });
  } catch (err) {
    return c.text(`Could not fetch the file: ${(err as Error).message}`, 502);
  }
});
