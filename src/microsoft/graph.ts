import { GRAPH_BASE_URL } from '../config.js';
import type { Account } from '../db/repo.js';
import { getAccessToken, rethrowAsReauthIfNeeded } from './oauth.js';

/** A Graph failure with the pieces worth acting on kept separate from the prose. */
export class GraphError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'GraphError';
    this.status = status;
    this.code = code;
  }
}

interface RequestOptions {
  headers?: Record<string, string>;
  /** Request body, JSON-encoded unless `rawBody` is set. */
  body?: unknown;
  rawBody?: { content: string | Buffer; contentType: string };
}

export interface Graph {
  readonly account: Account;
  get<T>(path: string, opts?: RequestOptions): Promise<T>;
  /** Follows @odata.nextLink until `limit` items are collected. */
  getAll<T>(path: string, limit: number, opts?: RequestOptions): Promise<T[]>;
  post<T>(path: string, body: unknown, opts?: RequestOptions): Promise<T>;
  /** For endpoints that answer 202/204 with no body, such as sendMail. */
  postNoContent(path: string, body: unknown, opts?: RequestOptions): Promise<void>;
  patch<T>(path: string, body: unknown, opts?: RequestOptions): Promise<T>;
  del(path: string): Promise<void>;
  getBinary(path: string): Promise<Buffer>;
  /** Absolute-URL request, for upload sessions which return their own host. */
  putRange(url: string, chunk: Buffer, start: number, end: number, total: number): Promise<Response>;
}

function messageOf(status: number, payload: unknown): { code: string; message: string } {
  const err = (payload as { error?: { code?: string; message?: string } } | undefined)?.error;
  return {
    code: err?.code ?? `http_${status}`,
    message: err?.message ?? `Microsoft Graph returned HTTP ${status}`,
  };
}

export async function graphFor(account: Account): Promise<Graph> {
  const token = await getAccessToken(account);

  async function request(
    method: string,
    path: string,
    opts: RequestOptions = {},
  ): Promise<Response> {
    const url = path.startsWith('https://') ? path : `${GRAPH_BASE_URL}${path}`;

    const headers: Record<string, string> = {
      authorization: `Bearer ${token}`,
      ...(opts.headers ?? {}),
    };

    let body: string | Uint8Array | undefined;
    if (opts.rawBody) {
      body =
        typeof opts.rawBody.content === 'string'
          ? opts.rawBody.content
          : new Uint8Array(opts.rawBody.content);
      headers['content-type'] = opts.rawBody.contentType;
    } else if (opts.body !== undefined) {
      body = JSON.stringify(opts.body);
      headers['content-type'] = 'application/json';
    }

    const res = await fetch(url, { method, headers, body: body as RequestInit['body'] });

    if (!res.ok) {
      const payload = await res.json().catch(() => undefined);
      const { code, message } = messageOf(res.status, payload);
      // Every Graph call funnels through here, so this one place is enough to
      // turn a dead or too-narrow grant into an actionable re-auth prompt.
      rethrowAsReauthIfNeeded(new GraphError(res.status, code, message), account);
    }

    return res;
  }

  async function json<T>(method: string, path: string, opts?: RequestOptions): Promise<T> {
    const res = await request(method, path, opts);
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }

  return {
    account,
    get: (path, opts) => json('GET', path, opts),

    async getAll<T>(path: string, limit: number, opts?: RequestOptions): Promise<T[]> {
      const items: T[] = [];
      let next: string | undefined = path;

      while (next && items.length < limit) {
        const page: { value?: T[]; '@odata.nextLink'?: string } = await json('GET', next, opts);
        items.push(...(page.value ?? []));
        next = page['@odata.nextLink'];
      }

      return items.slice(0, limit);
    },

    post: (path, body, opts) => json('POST', path, { ...opts, body }),

    async postNoContent(path, body, opts): Promise<void> {
      await request('POST', path, { ...opts, body });
    },

    patch: (path, body, opts) => json('PATCH', path, { ...opts, body }),

    async del(path): Promise<void> {
      await request('DELETE', path);
    },

    async getBinary(path): Promise<Buffer> {
      const res = await request('GET', path);
      return Buffer.from(await res.arrayBuffer());
    },

    async putRange(url, chunk, start, end, total): Promise<Response> {
      // Upload-session URLs carry their own pre-authorised token; sending ours
      // as well is rejected outright by the storage service.
      return fetch(url, {
        method: 'PUT',
        headers: {
          'content-length': String(chunk.byteLength),
          'content-range': `bytes ${start}-${end}/${total}`,
        },
        body: new Uint8Array(chunk),
      });
    },
  };
}
