import { Readable } from 'node:stream';
import { google, type drive_v3 } from 'googleapis';
import type { OAuth2Client } from 'google-auth-library';

export function driveFor(auth: OAuth2Client): drive_v3.Drive {
  return google.drive({ version: 'v3', auth });
}

/**
 * Every call passes these. Without them the API silently pretends shared drives
 * do not exist — a search returns a confident, wrong "no results" for anything
 * living in a Workspace team drive.
 */
const ALL_DRIVES = {
  supportsAllDrives: true,
  includeItemsFromAllDrives: true,
} as const;

const FILE_FIELDS =
  'id, name, mimeType, size, modifiedTime, createdTime, owners(emailAddress,displayName), ' +
  'parents, webViewLink, iconLink, trashed, shared, driveId, description, md5Checksum';

/* ------------------------------------------------------------------ *
 * Google-native formats
 * ------------------------------------------------------------------ */

export const GOOGLE_DOC = 'application/vnd.google-apps.document';
export const GOOGLE_SHEET = 'application/vnd.google-apps.spreadsheet';
export const GOOGLE_SLIDES = 'application/vnd.google-apps.presentation';
export const GOOGLE_DRAWING = 'application/vnd.google-apps.drawing';
export const GOOGLE_FOLDER = 'application/vnd.google-apps.folder';

/** Google-native files hold no bytes of their own; they must be exported. */
export function isGoogleNative(mimeType: string): boolean {
  return mimeType.startsWith('application/vnd.google-apps.');
}

export function isFolder(mimeType: string): boolean {
  return mimeType === GOOGLE_FOLDER;
}

/** What a Google-native file becomes when you want to read it as text. */
export function defaultTextExport(mimeType: string): string | null {
  switch (mimeType) {
    case GOOGLE_DOC:
      return 'text/markdown';
    case GOOGLE_SHEET:
      return 'text/csv';
    case GOOGLE_SLIDES:
      return 'text/plain';
    default:
      return null;
  }
}

/** What a Google-native file becomes when you want to download it as a file. */
export function defaultBinaryExport(mimeType: string): string | null {
  switch (mimeType) {
    case GOOGLE_DOC:
      return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    case GOOGLE_SHEET:
      return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
    case GOOGLE_SLIDES:
      return 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
    case GOOGLE_DRAWING:
      return 'image/png';
    default:
      return null;
  }
}

/** File extension to append when exporting, so the download has a sensible name. */
export function extensionForExport(exportMimeType: string): string {
  const map: Record<string, string> = {
    'text/markdown': '.md',
    'text/plain': '.txt',
    'text/csv': '.csv',
    'text/html': '.html',
    'application/pdf': '.pdf',
    'image/png': '.png',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation': '.pptx',
  };
  return map[exportMimeType] ?? '';
}

/* ------------------------------------------------------------------ *
 * Summaries
 * ------------------------------------------------------------------ */

export interface DriveFileSummary {
  id: string;
  name: string;
  mimeType: string;
  kind: 'folder' | 'google-doc' | 'google-sheet' | 'google-slides' | 'file';
  sizeBytes: number | null;
  modifiedTime: string | null;
  createdTime: string | null;
  owner: string | null;
  webViewLink: string | null;
  parents: string[];
  trashed: boolean;
  shared: boolean;
  inSharedDrive: boolean;
  description: string | null;
  /** True when the file must be exported rather than downloaded directly. */
  needsExport: boolean;
}

function kindOf(mimeType: string): DriveFileSummary['kind'] {
  if (mimeType === GOOGLE_FOLDER) return 'folder';
  if (mimeType === GOOGLE_DOC) return 'google-doc';
  if (mimeType === GOOGLE_SHEET) return 'google-sheet';
  if (mimeType === GOOGLE_SLIDES) return 'google-slides';
  return 'file';
}

export function toFileSummary(f: drive_v3.Schema$File): DriveFileSummary {
  const mimeType = f.mimeType ?? 'application/octet-stream';
  return {
    id: f.id ?? '',
    name: f.name ?? '(unnamed)',
    mimeType,
    kind: kindOf(mimeType),
    sizeBytes: f.size ? Number(f.size) : null,
    modifiedTime: f.modifiedTime ?? null,
    createdTime: f.createdTime ?? null,
    owner: f.owners?.[0]?.emailAddress ?? null,
    webViewLink: f.webViewLink ?? null,
    parents: f.parents ?? [],
    trashed: f.trashed ?? false,
    shared: f.shared ?? false,
    inSharedDrive: !!f.driveId,
    description: f.description ?? null,
    needsExport: isGoogleNative(mimeType) && !isFolder(mimeType),
  };
}

/* ------------------------------------------------------------------ *
 * Reading
 * ------------------------------------------------------------------ */

export async function searchFiles(
  drive: drive_v3.Drive,
  params: { query: string; limit: number; includeTrashed: boolean; orderBy?: string },
): Promise<DriveFileSummary[]> {
  // Drive returns trashed files unless told otherwise, which surprises callers
  // who searched for a name they thought they had deleted.
  const q = params.includeTrashed
    ? params.query || undefined
    : params.query
      ? `(${params.query}) and trashed = false`
      : 'trashed = false';

  const res = await drive.files.list({
    q,
    pageSize: params.limit,
    fields: `files(${FILE_FIELDS})`,
    orderBy: params.orderBy ?? 'modifiedTime desc',
    ...ALL_DRIVES,
  });

  return (res.data.files ?? []).map(toFileSummary);
}

export async function getFileMetadata(
  drive: drive_v3.Drive,
  fileId: string,
): Promise<DriveFileSummary> {
  const res = await drive.files.get({ fileId, fields: FILE_FIELDS, ...ALL_DRIVES });
  return toFileSummary(res.data);
}

/**
 * Fetches the bytes of a file, exporting Google-native formats on the way.
 * Returns the effective content type, which may differ from the file's own.
 */
export async function getFileBytes(
  drive: drive_v3.Drive,
  file: DriveFileSummary,
  exportMimeType?: string,
): Promise<{ data: Buffer; contentType: string; exported: boolean }> {
  if (isFolder(file.mimeType)) {
    throw new Error(`"${file.name}" is a folder, not a file. Use list_drive_folder instead.`);
  }

  if (file.needsExport) {
    const target = exportMimeType ?? defaultBinaryExport(file.mimeType);
    if (!target) {
      throw new Error(
        `"${file.name}" is a ${file.mimeType} and cannot be exported to a downloadable format.`,
      );
    }
    const res = await drive.files.export(
      { fileId: file.id, mimeType: target },
      { responseType: 'arraybuffer' },
    );
    return { data: Buffer.from(res.data as ArrayBuffer), contentType: target, exported: true };
  }

  const res = await drive.files.get(
    { fileId: file.id, alt: 'media', ...ALL_DRIVES },
    { responseType: 'arraybuffer' },
  );
  return {
    data: Buffer.from(res.data as ArrayBuffer),
    contentType: file.mimeType,
    exported: false,
  };
}

export async function listFolder(
  drive: drive_v3.Drive,
  folderId: string,
  limit: number,
): Promise<DriveFileSummary[]> {
  const res = await drive.files.list({
    q: `'${folderId.replace(/'/g, "\\'")}' in parents and trashed = false`,
    pageSize: limit,
    fields: `files(${FILE_FIELDS})`,
    orderBy: 'folder, name',
    ...ALL_DRIVES,
  });
  return (res.data.files ?? []).map(toFileSummary);
}

/* ------------------------------------------------------------------ *
 * Writing
 * ------------------------------------------------------------------ */

export async function uploadFile(
  drive: drive_v3.Drive,
  params: {
    name: string;
    mimeType: string;
    content: Buffer;
    parentFolderId?: string;
    description?: string;
    convertToGoogleDoc?: boolean;
  },
): Promise<DriveFileSummary> {
  const res = await drive.files.create({
    requestBody: {
      name: params.name,
      ...(params.parentFolderId ? { parents: [params.parentFolderId] } : {}),
      ...(params.description ? { description: params.description } : {}),
      ...(params.convertToGoogleDoc ? { mimeType: GOOGLE_DOC } : {}),
    },
    media: {
      mimeType: params.mimeType,
      body: Readable.from(params.content),
    },
    fields: FILE_FIELDS,
    ...ALL_DRIVES,
  });
  return toFileSummary(res.data);
}

export async function createFolder(
  drive: drive_v3.Drive,
  name: string,
  parentFolderId?: string,
): Promise<DriveFileSummary> {
  const res = await drive.files.create({
    requestBody: {
      name,
      mimeType: GOOGLE_FOLDER,
      ...(parentFolderId ? { parents: [parentFolderId] } : {}),
    },
    fields: FILE_FIELDS,
    ...ALL_DRIVES,
  });
  return toFileSummary(res.data);
}

export async function updateFile(
  drive: drive_v3.Drive,
  fileId: string,
  changes: { name?: string; description?: string; moveToFolderId?: string },
): Promise<DriveFileSummary> {
  let removeParents: string | undefined;
  if (changes.moveToFolderId) {
    const current = await drive.files.get({ fileId, fields: 'parents', ...ALL_DRIVES });
    removeParents = (current.data.parents ?? []).join(',') || undefined;
  }

  const res = await drive.files.update({
    fileId,
    requestBody: {
      ...(changes.name !== undefined ? { name: changes.name } : {}),
      ...(changes.description !== undefined ? { description: changes.description } : {}),
    },
    ...(changes.moveToFolderId ? { addParents: changes.moveToFolderId, removeParents } : {}),
    fields: FILE_FIELDS,
    ...ALL_DRIVES,
  });
  return toFileSummary(res.data);
}

export async function replaceFileContent(
  drive: drive_v3.Drive,
  fileId: string,
  mimeType: string,
  content: Buffer,
): Promise<DriveFileSummary> {
  const res = await drive.files.update({
    fileId,
    media: { mimeType, body: Readable.from(content) },
    fields: FILE_FIELDS,
    ...ALL_DRIVES,
  });
  return toFileSummary(res.data);
}

export async function copyFile(
  drive: drive_v3.Drive,
  fileId: string,
  newName?: string,
  parentFolderId?: string,
): Promise<DriveFileSummary> {
  const res = await drive.files.copy({
    fileId,
    requestBody: {
      ...(newName ? { name: newName } : {}),
      ...(parentFolderId ? { parents: [parentFolderId] } : {}),
    },
    fields: FILE_FIELDS,
    ...ALL_DRIVES,
  });
  return toFileSummary(res.data);
}

/**
 * Moves a file to the bin. Deliberately never `files.delete`, which is
 * irreversible — same reasoning as choosing gmail.modify over full Gmail access.
 */
export async function trashFile(
  drive: drive_v3.Drive,
  fileId: string,
): Promise<DriveFileSummary> {
  const res = await drive.files.update({
    fileId,
    requestBody: { trashed: true },
    fields: FILE_FIELDS,
    ...ALL_DRIVES,
  });
  return toFileSummary(res.data);
}

export async function restoreFile(
  drive: drive_v3.Drive,
  fileId: string,
): Promise<DriveFileSummary> {
  const res = await drive.files.update({
    fileId,
    requestBody: { trashed: false },
    fields: FILE_FIELDS,
    ...ALL_DRIVES,
  });
  return toFileSummary(res.data);
}

/* ------------------------------------------------------------------ *
 * Permissions
 * ------------------------------------------------------------------ */

export interface DrivePermission {
  id: string;
  type: string;
  role: string;
  emailAddress: string | null;
  domain: string | null;
  /** True for "anyone with the link" — i.e. reachable outside the organisation. */
  isPublic: boolean;
}

export async function listPermissions(
  drive: drive_v3.Drive,
  fileId: string,
): Promise<DrivePermission[]> {
  const res = await drive.permissions.list({
    fileId,
    fields: 'permissions(id, type, role, emailAddress, domain)',
    ...ALL_DRIVES,
  });
  return (res.data.permissions ?? []).map((p) => ({
    id: p.id ?? '',
    type: p.type ?? '',
    role: p.role ?? '',
    emailAddress: p.emailAddress ?? null,
    domain: p.domain ?? null,
    isPublic: p.type === 'anyone',
  }));
}

/**
 * Grants access to one named person.
 *
 * Only ever creates `type: "user"` permissions. Public link sharing is not
 * reachable through this server by design: a wrongly shared file is hard to
 * notice after the fact, and an agent should not be able to make that mistake
 * on the user's behalf.
 */
export async function shareWithUser(
  drive: drive_v3.Drive,
  fileId: string,
  emailAddress: string,
  role: 'reader' | 'commenter' | 'writer',
  options: { notify: boolean; message?: string },
): Promise<DrivePermission> {
  const res = await drive.permissions.create({
    fileId,
    sendNotificationEmail: options.notify,
    ...(options.notify && options.message ? { emailMessage: options.message } : {}),
    requestBody: { type: 'user', role, emailAddress },
    fields: 'id, type, role, emailAddress, domain',
    ...ALL_DRIVES,
  });
  return {
    id: res.data.id ?? '',
    type: res.data.type ?? 'user',
    role: res.data.role ?? role,
    emailAddress: res.data.emailAddress ?? emailAddress,
    domain: res.data.domain ?? null,
    isPublic: false,
  };
}

export async function revokePermission(
  drive: drive_v3.Drive,
  fileId: string,
  permissionId: string,
): Promise<void> {
  await drive.permissions.delete({ fileId, permissionId, ...ALL_DRIVES });
}

export async function getStorageQuota(
  drive: drive_v3.Drive,
): Promise<{ limitBytes: number | null; usageBytes: number; usageInDriveBytes: number }> {
  const res = await drive.about.get({ fields: 'storageQuota' });
  const q = res.data.storageQuota ?? {};
  return {
    limitBytes: q.limit ? Number(q.limit) : null,
    usageBytes: q.usage ? Number(q.usage) : 0,
    usageInDriveBytes: q.usageInDrive ? Number(q.usageInDrive) : 0,
  };
}
