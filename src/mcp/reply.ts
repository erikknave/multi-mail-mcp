import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { ReauthRequiredError } from '../google/oauth.js';
import { ServiceError } from '../service.js';

/** JSON payload as the tool's text content, pretty-printed for readability. */
export function ok(data: unknown): CallToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
  };
}

export function text(message: string): CallToolResult {
  return { content: [{ type: 'text', text: message }] };
}

export function fail(message: string): CallToolResult {
  return { content: [{ type: 'text', text: message }], isError: true };
}

/**
 * Wraps a tool body so failures come back as readable, actionable text rather
 * than a transport-level error.
 *
 * A dead Google grant is the case that matters: it becomes an explicit
 * instruction plus a link, which is what lets an agent recover the situation by
 * simply asking the user to click it.
 */
export async function guard(fn: () => Promise<CallToolResult>): Promise<CallToolResult> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof ReauthRequiredError) {
      return fail(
        `ACTION REQUIRED — Google access for ${err.accountEmail} has expired.\n\n` +
          `Ask the user to open this link, sign in as ${err.accountEmail}, and approve access:\n` +
          `${err.reauthUrl}\n\n` +
          `Once they confirm they are done, retry this tool call. ` +
          `(Underlying reason: ${err.reason})`,
      );
    }
    if (err instanceof ServiceError) {
      return fail(err.message);
    }

    const e = err as { message?: string; errors?: Array<{ message?: string }> };
    const detail = e?.errors?.[0]?.message ?? e?.message ?? String(err);
    return fail(`Google API call failed: ${detail}`);
  }
}
