import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { User } from '../../db/repo.js';
import {
  copyFile,
  createFolder,
  defaultTextExport,
  getFileBytes,
  getFileMetadata,
  getStorageQuota,
  isFolder,
  listFolder,
  listPermissions,
  replaceFileContent,
  restoreFile,
  revokePermission,
  searchFiles,
  shareWithUser,
  trashFile,
  updateFile,
  uploadFile,
} from '../../google/drive.js';
import { ReauthRequiredError, ScopeMissingError } from '../../google/oauth.js';
import {
  buildDriveDownloadUrl,
  driveClient,
  getReadyUpload,
  resolveAccount,
  resolveAccounts,
  ServiceError,
} from '../../service.js';
import { guard, ok, partial, type AccountProblem } from '../reply.js';

const accountArg = z
  .string()
  .optional()
  .describe('Account whose Drive to use. Omit when only one account is connected.');

/** Text extracted from a document can be enormous; keep it bounded. */
function clamp(text: string, maxChars: number): { text: string; truncated: boolean } {
  if (text.length <= maxChars) return { text, truncated: false };
  return {
    text: `${text.slice(0, maxChars)}\n\n[...truncated, ${text.length - maxChars} more characters]`,
    truncated: true,
  };
}

export function registerDriveTools(server: McpServer, user: User): void {
  /* ---------------------------------------------------------------- *
   * Search and read
   * ---------------------------------------------------------------- */

  server.registerTool(
    'search_drive',
    {
      title: 'Search Google Drive',
      description:
        'Searches Drive across one or several connected accounts, including shared drives. ' +
        'Uses Drive query syntax, which is NOT the same as Gmail\'s. Common forms:\n' +
        "  name contains 'invoice'\n" +
        "  fullText contains 'quarterly report'\n" +
        "  mimeType = 'application/pdf'\n" +
        "  modifiedTime > '2026-01-01T00:00:00'\n" +
        "  '<folderId>' in parents\n" +
        'Combine with `and` / `or`. String literals need single quotes. Returns metadata ' +
        'only — call read_drive_file for contents or get_drive_download_url for the bytes.',
      inputSchema: {
        query: z
          .string()
          .describe("Drive query, e.g. \"name contains 'budget' and mimeType = 'application/pdf'\". Empty string lists recent files."),
        accounts: z
          .array(z.string())
          .optional()
          .describe('Account addresses to search. Omit to search all connected accounts.'),
        limit: z.number().int().min(1).max(100).default(25).describe('Max results per account.'),
        includeTrashed: z
          .boolean()
          .default(false)
          .describe('Include files in the bin. Excluded by default.'),
        orderBy: z
          .string()
          .optional()
          .describe("Sort order, e.g. 'modifiedTime desc' (default), 'name', 'quotaBytesUsed desc'."),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ query, accounts, limit, includeTrashed, orderBy }) =>
      guard(async () => {
        const targets = resolveAccounts(user, accounts);

        const perAccount = await Promise.all(
          targets.map(async (acc) => {
            try {
              const drive = await driveClient(acc);
              const files = await searchFiles(drive, { query, limit, includeTrashed, orderBy });
              return { account: acc.email, ok: true as const, files };
            } catch (err) {
              if (err instanceof ReauthRequiredError) {
                return {
                  account: acc.email,
                  ok: false as const,
                  error: 'needs_reauth',
                  reauthUrl: err.reauthUrl,
                  files: [],
                };
              }
              if (err instanceof ScopeMissingError) {
                return {
                  account: acc.email,
                  ok: false as const,
                  error: 'drive access not granted — the account needs to approve it',
                  reauthUrl: err.reauthUrl,
                  files: [],
                };
              }
              return {
                account: acc.email,
                ok: false as const,
                error: (err as Error).message,
                files: [],
              };
            }
          }),
        );

        const merged = perAccount.flatMap((r) =>
          r.files.map((f) => ({ account: r.account, ...f })),
        );

        const problems: AccountProblem[] = perAccount
          .filter((r) => !r.ok)
          .map((f) => ({
            account: f.account,
            error: f.error ?? 'unknown error',
            ...('reauthUrl' in f && f.reauthUrl ? { reauthUrl: f.reauthUrl } : {}),
          }));

        return partial(
          {
            query,
            drivesSearched: targets.length - problems.length,
            drivesRequested: targets.length,
            totalResults: merged.length,
            files: merged,
          },
          problems,
          'Drive files',
        );
      }),
  );

  server.registerTool(
    'read_drive_file',
    {
      title: 'Read a Drive file as text',
      description:
        'Returns the text content of a Drive file. Google Docs, Sheets and Slides are ' +
        'exported automatically (Docs to Markdown, Sheets to CSV, Slides to plain text). ' +
        'Binary formats such as PDF or images cannot be read as text — use ' +
        'get_drive_download_url for those and hand the URL to the user.',
      inputSchema: {
        fileId: z.string().describe('Drive file id, from search_drive.'),
        account: accountArg,
        maxChars: z
          .number()
          .int()
          .min(500)
          .max(500000)
          .default(50000)
          .describe('Truncate the content beyond this many characters.'),
        exportAs: z
          .string()
          .optional()
          .describe(
            "Override the export format for Google-native files, e.g. 'text/csv', " +
              "'text/plain', 'text/html'.",
          ),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ fileId, account, maxChars, exportAs }) =>
      guard(async () => {
        const acc = resolveAccount(user, account);
        const drive = await driveClient(acc);
        const meta = await getFileMetadata(drive, fileId);

        if (isFolder(meta.mimeType)) {
          throw new ServiceError(
            `"${meta.name}" is a folder. Use list_drive_folder to see what is inside it.`,
          );
        }

        const target = exportAs ?? (meta.needsExport ? defaultTextExport(meta.mimeType) : null);

        if (meta.needsExport && !target) {
          throw new ServiceError(
            `"${meta.name}" (${meta.mimeType}) has no sensible text form. ` +
              'Use get_drive_download_url instead.',
          );
        }

        const { data, contentType } = await getFileBytes(drive, meta, target ?? undefined);

        // Reading arbitrary bytes as UTF-8 produces mojibake, not an error, so
        // refuse rather than hand back convincing nonsense.
        const readable =
          contentType.startsWith('text/') ||
          contentType === 'application/json' ||
          contentType === 'application/xml';

        if (!readable) {
          throw new ServiceError(
            `"${meta.name}" is ${contentType}, which is not text. ` +
              'Use get_drive_download_url to give the user a download link instead.',
          );
        }

        const { text, truncated } = clamp(data.toString('utf8'), maxChars);
        return ok({
          account: acc.email,
          file: meta,
          contentType,
          exported: meta.needsExport,
          contentTruncated: truncated,
          content: text,
        });
      }),
  );

  server.registerTool(
    'list_drive_folder',
    {
      title: 'List a Drive folder',
      description:
        'Lists the direct contents of a folder, folders first. Use the id "root" for the ' +
        'top level of My Drive.',
      inputSchema: {
        folderId: z.string().default('root').describe('Folder id, or "root" for My Drive.'),
        account: accountArg,
        limit: z.number().int().min(1).max(200).default(100).describe('Max entries.'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ folderId, account, limit }) =>
      guard(async () => {
        const acc = resolveAccount(user, account);
        const drive = await driveClient(acc);
        const entries = await listFolder(drive, folderId, limit);
        return ok({
          account: acc.email,
          folderId,
          entryCount: entries.length,
          entries,
        });
      }),
  );

  server.registerTool(
    'get_drive_download_url',
    {
      title: 'Get a download link for a Drive file',
      description:
        'Produces a time-limited direct download URL for a Drive file, suitable for handing ' +
        'to the user. Google Docs, Sheets and Slides are converted on download (to .docx, ' +
        '.xlsx and .pptx by default). The file streams from Drive on demand; nothing is ' +
        'stored on the server.',
      inputSchema: {
        fileId: z.string().describe('Drive file id, from search_drive.'),
        account: accountArg,
        exportAs: z
          .string()
          .optional()
          .describe(
            "Export format for Google-native files, e.g. 'application/pdf', 'text/csv'. " +
              'Ignored for ordinary files.',
          ),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ fileId, account, exportAs }) =>
      guard(async () => {
        const acc = resolveAccount(user, account);
        const drive = await driveClient(acc);
        const meta = await getFileMetadata(drive, fileId);

        if (isFolder(meta.mimeType)) {
          throw new ServiceError(`"${meta.name}" is a folder and cannot be downloaded.`);
        }

        const { url, expiresAt } = buildDriveDownloadUrl({
          user,
          account: acc,
          fileId,
          filename: meta.name,
          exportMimeType: exportAs,
        });

        return ok({
          account: acc.email,
          file: meta.name,
          willBeConverted: meta.needsExport,
          downloadUrl: url,
          expiresAt,
        });
      }),
  );

  /* ---------------------------------------------------------------- *
   * Write
   * ---------------------------------------------------------------- */

  server.registerTool(
    'upload_to_drive',
    {
      title: 'Upload a file to Drive',
      description:
        'Uploads a staged file to Drive. First call create_upload_url and have the file PUT ' +
        'to that URL, then pass the uploadId here. Optionally converts to a Google Doc.',
      inputSchema: {
        uploadId: z.string().describe('Id from create_upload_url, after the file was uploaded.'),
        name: z
          .string()
          .optional()
          .describe('Name in Drive. Defaults to the uploaded filename.'),
        parentFolderId: z
          .string()
          .optional()
          .describe('Destination folder id. Defaults to the top of My Drive.'),
        description: z.string().optional().describe('File description.'),
        convertToGoogleDoc: z
          .boolean()
          .default(false)
          .describe('Convert an uploaded document into an editable Google Doc.'),
        account: accountArg,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async ({ uploadId, name, parentFolderId, description, convertToGoogleDoc, account }) =>
      guard(async () => {
        const acc = resolveAccount(user, account);
        const drive = await driveClient(acc);
        const upload = getReadyUpload(user, uploadId);

        const file = await uploadFile(drive, {
          name: name ?? upload.filename,
          mimeType: upload.mime_type,
          content: await readFile(upload.path),
          parentFolderId,
          description,
          convertToGoogleDoc,
        });

        return ok({ uploaded: true, account: acc.email, file });
      }),
  );

  server.registerTool(
    'write_drive_file',
    {
      title: 'Create or overwrite a text file in Drive',
      description:
        'Writes text straight to Drive without staging an upload — the quick path for notes, ' +
        'reports and generated documents. Give fileId to overwrite an existing file, or name ' +
        'to create a new one. Set asGoogleDoc to get an editable Google Doc rather than a ' +
        'plain text file. Overwriting replaces the entire content.',
      inputSchema: {
        content: z.string().describe('The text to write.'),
        fileId: z
          .string()
          .optional()
          .describe('Existing file to overwrite. Omit to create a new file.'),
        name: z.string().optional().describe('Name for a new file. Required unless fileId is given.'),
        mimeType: z
          .string()
          .default('text/plain')
          .describe("Content type, e.g. 'text/plain', 'text/markdown', 'text/csv'."),
        parentFolderId: z.string().optional().describe('Destination folder for a new file.'),
        asGoogleDoc: z
          .boolean()
          .default(false)
          .describe('Create as an editable Google Doc instead of a plain file.'),
        account: accountArg,
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    async ({ content, fileId, name, mimeType, parentFolderId, asGoogleDoc, account }) =>
      guard(async () => {
        const acc = resolveAccount(user, account);
        const drive = await driveClient(acc);
        const bytes = Buffer.from(content, 'utf8');

        if (fileId) {
          const existing = await getFileMetadata(drive, fileId);
          const file = await replaceFileContent(drive, fileId, mimeType, bytes);
          return ok({
            overwritten: true,
            account: acc.email,
            previousSizeBytes: existing.sizeBytes,
            file,
          });
        }

        if (!name) {
          throw new ServiceError('Give either fileId (to overwrite) or name (to create).');
        }

        const file = await uploadFile(drive, {
          name,
          mimeType,
          content: bytes,
          parentFolderId,
          convertToGoogleDoc: asGoogleDoc,
        });
        return ok({ created: true, account: acc.email, file });
      }),
  );

  server.registerTool(
    'create_drive_folder',
    {
      title: 'Create a Drive folder',
      description: 'Creates a folder, optionally inside another folder.',
      inputSchema: {
        name: z.string().describe('Folder name.'),
        parentFolderId: z.string().optional().describe('Parent folder id. Defaults to My Drive.'),
        account: accountArg,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async ({ name, parentFolderId, account }) =>
      guard(async () => {
        const acc = resolveAccount(user, account);
        const drive = await driveClient(acc);
        return ok({
          created: true,
          account: acc.email,
          folder: await createFolder(drive, name, parentFolderId),
        });
      }),
  );

  server.registerTool(
    'update_drive_file',
    {
      title: 'Rename, describe or move a Drive file',
      description:
        'Changes a file or folder\'s name, description or location. Only the fields you give ' +
        'are touched. Does not change the content — use write_drive_file for that.',
      inputSchema: {
        fileId: z.string().describe('File or folder id.'),
        name: z.string().optional().describe('New name.'),
        description: z.string().optional().describe('New description.'),
        moveToFolderId: z.string().optional().describe('Folder to move it into.'),
        account: accountArg,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async ({ fileId, name, description, moveToFolderId, account }) =>
      guard(async () => {
        if (name === undefined && description === undefined && moveToFolderId === undefined) {
          throw new ServiceError('Nothing to change: give name, description or moveToFolderId.');
        }
        const acc = resolveAccount(user, account);
        const drive = await driveClient(acc);
        return ok({
          updated: true,
          account: acc.email,
          file: await updateFile(drive, fileId, { name, description, moveToFolderId }),
        });
      }),
  );

  server.registerTool(
    'copy_drive_file',
    {
      title: 'Copy a Drive file',
      description:
        'Duplicates a file, optionally with a new name and into a different folder. ' +
        'Useful for working from a template without disturbing the original.',
      inputSchema: {
        fileId: z.string().describe('File to copy.'),
        newName: z.string().optional().describe('Name for the copy.'),
        parentFolderId: z.string().optional().describe('Folder to put the copy in.'),
        account: accountArg,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async ({ fileId, newName, parentFolderId, account }) =>
      guard(async () => {
        const acc = resolveAccount(user, account);
        const drive = await driveClient(acc);
        return ok({
          copied: true,
          account: acc.email,
          file: await copyFile(drive, fileId, newName, parentFolderId),
        });
      }),
  );

  server.registerTool(
    'trash_drive_file',
    {
      title: 'Move a Drive file to the bin',
      description:
        'Moves a file or folder to the bin, where Drive keeps it for 30 days. This server ' +
        'never deletes permanently, so the action is reversible with restore_drive_file. ' +
        'Confirm with the user before trashing anything they did not explicitly name.',
      inputSchema: {
        fileId: z.string().describe('File or folder id.'),
        account: accountArg,
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    async ({ fileId, account }) =>
      guard(async () => {
        const acc = resolveAccount(user, account);
        const drive = await driveClient(acc);
        const file = await trashFile(drive, fileId);
        return ok({
          trashed: true,
          account: acc.email,
          file,
          note: 'Recoverable from the bin for 30 days, or with restore_drive_file.',
        });
      }),
  );

  server.registerTool(
    'restore_drive_file',
    {
      title: 'Restore a Drive file from the bin',
      description: 'Takes a file back out of the bin.',
      inputSchema: {
        fileId: z.string().describe('File or folder id.'),
        account: accountArg,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async ({ fileId, account }) =>
      guard(async () => {
        const acc = resolveAccount(user, account);
        const drive = await driveClient(acc);
        return ok({ restored: true, account: acc.email, file: await restoreFile(drive, fileId) });
      }),
  );

  /* ---------------------------------------------------------------- *
   * Sharing
   * ---------------------------------------------------------------- */

  server.registerTool(
    'get_drive_permissions',
    {
      title: 'See who can access a Drive file',
      description:
        'Lists everyone with access to a file, and flags whether it is reachable by anyone ' +
        'with the link. Worth checking before sharing anything sensitive further.',
      inputSchema: {
        fileId: z.string().describe('File or folder id.'),
        account: accountArg,
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ fileId, account }) =>
      guard(async () => {
        const acc = resolveAccount(user, account);
        const drive = await driveClient(acc);
        const permissions = await listPermissions(drive, fileId);
        const publicly = permissions.filter((p) => p.isPublic);

        return ok({
          account: acc.email,
          fileId,
          permissions,
          publiclyAccessible: publicly.length > 0,
          ...(publicly.length
            ? {
                warning:
                  'This file is reachable by anyone with the link. Take that into account ' +
                  'before sharing the link further or storing anything sensitive in it.',
              }
            : {}),
        });
      }),
  );

  server.registerTool(
    'share_drive_file',
    {
      title: 'Share a Drive file with a person',
      description:
        'Grants a named person access to a file. Only individual people can be granted ' +
        'access through this server — it cannot create "anyone with the link" sharing, ' +
        'because a mistakenly public file is hard to notice afterwards. If the user really ' +
        'wants a public link, they must do it themselves in the Drive interface.',
      inputSchema: {
        fileId: z.string().describe('File or folder id.'),
        emailAddress: z.string().describe('The person to share with.'),
        role: z
          .enum(['reader', 'commenter', 'writer'])
          .default('reader')
          .describe('What they may do. Prefer reader unless editing is genuinely needed.'),
        notify: z.boolean().default(true).describe('Send them a notification email.'),
        message: z.string().optional().describe('Note to include in the notification.'),
        account: accountArg,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async ({ fileId, emailAddress, role, notify, message, account }) =>
      guard(async () => {
        if (!emailAddress.includes('@')) {
          throw new ServiceError(
            `"${emailAddress}" is not an email address. This tool shares with named people ` +
              'only; public link sharing is not available here.',
          );
        }

        const acc = resolveAccount(user, account);
        const drive = await driveClient(acc);
        const permission = await shareWithUser(drive, fileId, emailAddress, role, {
          notify,
          message,
        });

        return ok({ shared: true, account: acc.email, fileId, permission });
      }),
  );

  server.registerTool(
    'unshare_drive_file',
    {
      title: "Remove someone's access to a Drive file",
      description:
        'Revokes a permission. Get the permissionId from get_drive_permissions. Can also ' +
        'remove a public-link permission, which is the one way this server can reduce ' +
        'public exposure.',
      inputSchema: {
        fileId: z.string().describe('File or folder id.'),
        permissionId: z.string().describe('Permission id, from get_drive_permissions.'),
        account: accountArg,
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    async ({ fileId, permissionId, account }) =>
      guard(async () => {
        const acc = resolveAccount(user, account);
        const drive = await driveClient(acc);
        await revokePermission(drive, fileId, permissionId);
        return ok({ revoked: true, account: acc.email, fileId, permissionId });
      }),
  );

  /* ---------------------------------------------------------------- *
   * Housekeeping
   * ---------------------------------------------------------------- */

  server.registerTool(
    'get_drive_usage',
    {
      title: 'Check Drive storage usage',
      description: 'Reports how much Drive storage the account is using, and its quota.',
      inputSchema: {
        accounts: z
          .array(z.string())
          .optional()
          .describe('Account addresses. Omit for all connected accounts.'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ accounts }) =>
      guard(async () => {
        const targets = resolveAccounts(user, accounts);
        const results = await Promise.all(
          targets.map(async (acc) => {
            try {
              const drive = await driveClient(acc);
              const q = await getStorageQuota(drive);
              const gb = (n: number) => Math.round((n / 1024 ** 3) * 100) / 100;
              return {
                account: acc.email,
                usedGb: gb(q.usageBytes),
                driveGb: gb(q.usageInDriveBytes),
                limitGb: q.limitBytes ? gb(q.limitBytes) : null,
                percentUsed: q.limitBytes
                  ? Math.round((q.usageBytes / q.limitBytes) * 1000) / 10
                  : null,
              };
            } catch (err) {
              if (err instanceof ReauthRequiredError || err instanceof ScopeMissingError) {
                return { account: acc.email, error: 'needs_reauth', reauthUrl: err.reauthUrl };
              }
              return { account: acc.email, error: (err as Error).message };
            }
          }),
        );

        const problems: AccountProblem[] = results
          .filter((r) => 'error' in r && r.error)
          .map((r) => ({
            account: r.account,
            error: (r as { error: string }).error,
            ...('reauthUrl' in r && r.reauthUrl ? { reauthUrl: r.reauthUrl as string } : {}),
          }));

        return partial({ accounts: results }, problems, 'storage figures');
      }),
  );
}
