import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { User } from '../../db/repo.js';
import { createUploadSlot, listUploads } from '../../service.js';
import { guard, ok } from '../reply.js';

export function registerFileTools(server: McpServer, user: User): void {
  server.registerTool(
    'create_upload_url',
    {
      title: 'Reserve an upload slot for an attachment',
      description:
        'Reserves a staging slot and returns a URL to PUT a file to. The returned uploadId ' +
        'can then be passed to send_message or create_draft as an attachment.\n\n' +
        'Give the uploadUrl to the user (or to whatever holds the file) and have them ' +
        'upload with a single PUT request, for example:\n' +
        '  curl -X PUT --upload-file ./report.pdf "<uploadUrl>"\n\n' +
        'Files are deleted automatically when the slot expires.',
      inputSchema: {
        filename: z.string().describe('Filename the recipient should see.'),
        mimeType: z
          .string()
          .default('application/octet-stream')
          .describe('Content type, e.g. application/pdf or image/png.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async ({ filename, mimeType }) =>
      guard(async () => {
        const { upload, url, expiresAt } = createUploadSlot(user, filename, mimeType);
        return ok({
          uploadId: upload.id,
          filename: upload.filename,
          mimeType: upload.mime_type,
          uploadUrl: url,
          expiresAt,
          howToUpload: `curl -X PUT --upload-file <path> "${url}"`,
          nextStep:
            'Once the file has been PUT, pass this uploadId in the uploadIds array of ' +
            'send_message or create_draft.',
        });
      }),
  );

  server.registerTool(
    'list_uploads',
    {
      title: 'List staged attachments',
      description:
        'Lists upload slots that have not expired, showing which have received a file. ' +
        'Use this to check whether the user has actually completed an upload before sending.',
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () =>
      guard(async () => {
        const all = listUploads(user);
        return ok({
          uploads: all.map((u) => ({
            uploadId: u.id,
            filename: u.filename,
            mimeType: u.mime_type,
            sizeBytes: u.size_bytes,
            uploaded: u.uploaded_at !== null,
            expiresAt: new Date(u.expires_at * 1000).toISOString(),
          })),
        });
      }),
  );
}
