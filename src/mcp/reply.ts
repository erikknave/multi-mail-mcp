import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { ReauthRequiredError } from '../google/oauth.js';
import { ServiceError } from '../service.js';

/** JSON payload as the tool's text content, pretty-printed for readability. */
export function ok(data: unknown): CallToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
  };
}

export interface AccountProblem {
  account: string;
  error: string;
  reauthUrl?: string;
}

/**
 * Wraps the result of an operation that ran across several mailboxes.
 *
 * A partial failure used to look exactly like a genuine empty result: the tool
 * returned `totalResults: 0` with the failure tucked away in a trailing field.
 * A caller that didn't think to read that field would conclude "nothing found"
 * when the truth was "we couldn't look".
 *
 * So when anything failed, the payload leads with `incomplete: true` and a
 * plain-language warning, both placed first in key order — a reader that only
 * skims the top of the object still cannot miss it.
 */
export function partial<T extends Record<string, unknown>>(
  data: T,
  problems: AccountProblem[],
  what: string,
): CallToolResult {
  if (problems.length === 0) {
    return ok({ ...data, incomplete: false });
  }

  const names = problems.map((p) => p.account).join(', ');
  const needReauth = problems.filter((p) => p.reauthUrl);

  const warning =
    `INCOMPLETE RESULT — ${problems.length} of the requested mailboxes could not be ` +
    `searched, so this is not the full picture. Do not report these ${what} as complete, ` +
    `and do not conclude that something is absent from mail you could not read. ` +
    `Affected: ${names}.` +
    (needReauth.length
      ? ` ${needReauth.length} ${needReauth.length === 1 ? 'needs' : 'need'} the user to ` +
        `renew access via the reauthUrl below.`
      : '');

  return ok({ incomplete: true, warning, ...data, accountsWithProblems: problems });
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
