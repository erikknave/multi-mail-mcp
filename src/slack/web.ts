import { SLACK_API_BASE_URL } from '../config.js';
import type { Account } from '../db/repo.js';
import { getSlackToken, rethrowAsReauthIfNeeded } from './oauth.js';

/** A Slack Web API failure with the pieces worth acting on kept separate from the prose. */
export class SlackApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'SlackApiError';
    this.status = status;
    this.code = code;
  }
}

/** How long a 429's Retry-After may delay us before we give up on the call. */
const MAX_RETRY_AFTER_SECONDS = 30;

function flatten(params: Record<string, string | number | boolean>): Record<string, string> {
  return Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)]));
}

export interface SlackWeb {
  readonly account: Account;
  get<T>(method: string, params?: Record<string, string | number | boolean>): Promise<T>;
  /**
   * Cursor-paginates a list method until `limit` items are collected. `listKey`
   * is where the method keeps its array: `channels` for conversations.list and
   * conversations.members, `messages` for history and replies.
   */
  getAll<T>(
    method: string,
    params: Record<string, string | number | boolean>,
    limit: number,
    listKey: 'channels' | 'messages' | 'members',
  ): Promise<T[]>;
  post<T>(method: string, params: Record<string, unknown>): Promise<T>;
}

/**
 * The thin Slack client, mirroring graphFor: every request funnels through one
 * place that turns ok:false and auth failures into actionable errors, so the
 * chat implementation never has to think about them.
 */
export async function slackWebFor(account: Account): Promise<SlackWeb> {
  const token = await getSlackToken(account);

  async function call(method: string, httpMethod: 'GET' | 'POST', params?: unknown): Promise<unknown> {
    const url =
      httpMethod === 'GET' && params
        ? `${SLACK_API_BASE_URL}/${method}?${new URLSearchParams(flatten(params as Record<string, string | number | boolean>))}`
        : `${SLACK_API_BASE_URL}/${method}`;

    const res = await fetch(url, {
      method: httpMethod,
      headers: {
        authorization: `Bearer ${token}`,
        ...(httpMethod === 'POST' ? { 'content-type': 'application/json' } : {}),
      },
      ...(httpMethod === 'POST' && params !== undefined ? { body: JSON.stringify(params) } : {}),
    });

    // Slack answers 429 with a Retry-After header in seconds. One patient
    // retry is part of normal operation (listChats fans out several calls);
    // a second would just move the failure around, and a rate limit must
    // never look like a dead grant.
    if (res.status === 429) {
      const wait = Math.min(Number(res.headers.get('retry-after') ?? 1), MAX_RETRY_AFTER_SECONDS);
      await new Promise((resolve) => setTimeout(resolve, wait * 1000));
      return call(method, httpMethod, params);
    }

    // The body, not the status, is where Slack reports most failures: HTTP 200
    // with ok:false is the normal shape for an application error.
    const body = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
    if (!res.ok || body.ok === false) {
      const code = body.error ?? `http_${res.status}`;
      rethrowAsReauthIfNeeded(
        new SlackApiError(res.status, code, `Slack ${method} failed: ${code}`),
        account,
      );
    }
    return body;
  }

  return {
    account,

    get<T>(method: string, params?: Record<string, string | number | boolean>): Promise<T> {
      return call(method, 'GET', params) as Promise<T>;
    },

    async getAll<T>(
      method: string,
      params: Record<string, string | number | boolean>,
      limit: number,
      listKey: 'channels' | 'messages' | 'members',
    ): Promise<T[]> {
      const items: T[] = [];
      let cursor = '';

      while (items.length < limit) {
        const page = (await call(method, 'GET', { ...params, ...(cursor ? { cursor } : {}) })) as {
          channels?: T[];
          messages?: T[];
          members?: T[];
          response_metadata?: { next_cursor?: string };
        };
        const batch =
          listKey === 'channels' ? page.channels : listKey === 'messages' ? page.messages : page.members;
        items.push(...(batch ?? []));
        // An empty string, not a missing field, is how Slack says "done".
        cursor = page.response_metadata?.next_cursor ?? '';
        if (!cursor) break;
      }

      return items.slice(0, limit);
    },

    post<T>(method: string, params: Record<string, unknown>): Promise<T> {
      return call(method, 'POST', params) as Promise<T>;
    },
  };
}
