import 'dotenv/config';
import { resolve } from 'node:path';

function required(name: string): string {
  const v = process.env[name];
  if (!v || v.trim() === '') {
    throw new Error(
      `Missing required environment variable ${name}. Copy .env.example to .env and fill it in.`,
    );
  }
  return v.trim();
}

function num(name: string, fallback: number): number {
  const v = process.env[name];
  if (!v) return fallback;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`Environment variable ${name} must be a number, got "${v}"`);
  return n;
}

/** 32-byte key decoded from base64. Throws if the wrong length. */
function key32(name: string): Buffer {
  const buf = Buffer.from(required(name), 'base64');
  if (buf.length !== 32) {
    throw new Error(
      `${name} must decode to exactly 32 bytes (got ${buf.length}). ` +
        `Generate one with: node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`,
    );
  }
  return buf;
}

function emailList(name: string): string[] {
  return (process.env[name] ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

const publicBaseUrl = required('PUBLIC_BASE_URL').replace(/\/+$/, '');

/** Microsoft support switches itself on once an app registration is supplied. */
const microsoftConfigured =
  !!process.env.MICROSOFT_CLIENT_ID?.trim() && !!process.env.MICROSOFT_CLIENT_SECRET?.trim();

/** Slack support likewise: a Slack app's credentials make the option appear. */
const slackConfigured =
  !!process.env.SLACK_CLIENT_ID?.trim() && !!process.env.SLACK_CLIENT_SECRET?.trim();

export const config = {
  port: num('PORT', 8456),
  publicBaseUrl,
  google: {
    clientId: required('GOOGLE_CLIENT_ID'),
    clientSecret: required('GOOGLE_CLIENT_SECRET'),
    /** Registered in Google Cloud Console. Must match exactly. */
    redirectUri: `${publicBaseUrl}/oauth/google/callback`,
  },
  /**
   * Microsoft is optional: the service runs perfectly well with Google only,
   * and a deployment that has not registered an Entra app should not fail to
   * start. Everything Microsoft-related checks this for null first.
   */
  microsoft: microsoftConfigured
    ? {
        clientId: required('MICROSOFT_CLIENT_ID'),
        clientSecret: required('MICROSOFT_CLIENT_SECRET'),
        /** Registered in Entra ID as a Web redirect URI. Must match exactly. */
        redirectUri: `${publicBaseUrl}/oauth/microsoft/callback`,
        /**
         * `organizations` accepts any work or school tenant but refuses personal
         * Microsoft accounts, whose Graph surface differs enough that silently
         * accepting one would produce confusing failures later. `common` would
         * allow both.
         */
        authority: (process.env.MICROSOFT_AUTHORITY?.trim() || 'organizations').replace(/\/+$/, ''),
      }
    : null,
  /**
   * Slack is optional in the same way Microsoft is: without an app configured
   * the dashboard does not offer it and no Slack code path runs. Unlike the
   * mailbox providers, a Slack account is chat-only.
   */
  slack: slackConfigured
    ? {
        clientId: required('SLACK_CLIENT_ID'),
        clientSecret: required('SLACK_CLIENT_SECRET'),
        /** Registered in the Slack app's OAuth & Permissions. Must match exactly. */
        redirectUri: `${publicBaseUrl}/oauth/slack/callback`,
      }
    : null,
  /**
   * Addresses permitted to create an account by signing in with Google.
   * Seeded into the allowed_logins table on startup; the table is authoritative
   * afterwards so admins can add colleagues from the web UI.
   */
  allowedLoginEmails: emailList('ALLOWED_LOGIN_EMAILS'),
  encryptionKey: key32('ENCRYPTION_KEY'),
  urlSigningSecret: key32('URL_SIGNING_SECRET'),
  dataDir: resolve(process.env.DATA_DIR?.trim() || './data'),
  downloadUrlTtl: num('DOWNLOAD_URL_TTL', 3600),
  uploadUrlTtl: num('UPLOAD_URL_TTL', 3600),
  reauthUrlTtl: num('REAUTH_URL_TTL', 86400),
  maxUploadBytes: num('MAX_UPLOAD_BYTES', 25 * 1024 * 1024),
} as const;

/**
 * Scopes requested per Google account.
 *
 * gmail.modify covers read + label changes + drafts but NOT permanent delete,
 * which is deliberate — an agent should never be able to hard-delete mail.
 * gmail.send is separate so sending is an explicit grant.
 */
export const GOOGLE_SCOPES = [
  'openid',
  'email',
  'profile',
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/calendar',
  'https://www.googleapis.com/auth/drive',
] as const;

/**
 * What a mailbox might be able to do. Not every provider offers every one, and
 * the maps below say which — a null means "this provider has no such thing",
 * which is a different situation from "offered, but not granted by this account".
 */
export type Capability = 'gmail' | 'calendar' | 'drive' | 'chat';

/**
 * Scopes a given capability needs, so we can tell an account that predates a
 * capability apart from one whose grant has actually died. Without this the
 * former shows up as an opaque 403 from deep inside googleapis.
 *
 * `chat` is null: Google Chat is a real product with a real API, but this
 * server does not implement it, and claiming the capability would promise
 * something no tool delivers.
 */
export const SCOPE_FOR: Record<Capability, string | null> = {
  gmail: 'https://www.googleapis.com/auth/gmail.modify',
  calendar: 'https://www.googleapis.com/auth/calendar',
  drive: 'https://www.googleapis.com/auth/drive',
  chat: null,
};

/**
 * Delegated Microsoft Graph permissions requested per Microsoft account.
 *
 * Mail.ReadWrite covers reading, moving, flagging and drafting but not
 * permanent deletion beyond moving to Deleted Items, matching the deliberate
 * limit on the Gmail side. Mail.Send is separate for the same reason it is on
 * Google: sending should be its own explicit grant.
 *
 * offline_access is what makes a refresh token appear at all — without it the
 * grant dies with the first access token and there is nothing to renew.
 */
export const GRAPH_SCOPES = [
  'openid',
  'email',
  'profile',
  'offline_access',
  'User.Read',
  'Mail.ReadWrite',
  'Mail.Send',
  'Calendars.ReadWrite',
  // Covers both reading and posting in the chats the signed-in user belongs to.
  // ChatMessage.Send would also authorise posting but adds nothing on top of it.
  'Chat.ReadWrite',
  // The documented permission for POST /chats. Chat.ReadWrite alone also
  // authorises it — verified against a live tenant — so an account connected
  // before this was requested can still start a chat without re-consenting.
  'Chat.Create',
] as const;

/**
 * The Graph permission behind each capability. `drive` is null because
 * OneDrive is deliberately out of scope for Microsoft accounts: the Drive,
 * Sheets and Docs tools are Google-only, and a null here is what lets them say
 * so precisely instead of failing with a permission error.
 */
export const GRAPH_SCOPE_FOR: Record<Capability, string | null> = {
  gmail: 'Mail.ReadWrite',
  calendar: 'Calendars.ReadWrite',
  drive: null,
  chat: 'Chat.ReadWrite',
};

/**
 * Slack user-token scopes requested per Slack account. These are *user* scopes:
 * the token (xoxp) acts as the member who authorised it — it reads exactly the
 * conversations they can read and posts as them, which is the same delegated
 * stance the Teams chat capability takes. No bot token is requested at all.
 *
 * The `*:read` scopes list conversations, `*:history` reads them,
 * `im:write`/`mpim:write` open DMs and group DMs, `users:read(.email)`
 * resolves member names, emails and address→user lookups, and `files:write`
 * uploads files the user sends into a conversation. Deliberately absent:
 * `channels:write`/`groups:write` (creating or renaming channels is not
 * something this server does) and `bots:read`/`files:read` (bot senders resolve
 * to "(app)" and received files are handed over as permalinks, as Teams
 * attachments are — files:write sends, it does not read).
 *
 * Adding a scope here has a cost outside the code: it must also be added under
 * "User Token Scopes" in the Slack app's OAuth settings, and every connected
 * Slack account must re-authorise before the new calls work. Until then the
 * server answers missing_scope with a renewal link rather than failing opaquely.
 */
export const SLACK_SCOPES = [
  'channels:read',
  'groups:read',
  'im:read',
  'mpim:read',
  'channels:history',
  'groups:history',
  'im:history',
  'mpim:history',
  'chat:write',
  'im:write',
  'mpim:write',
  'users:read',
  'users:read.email',
  'files:write',
] as const;

/**
 * Slack is chat-only: null for everything else, which is what makes mail,
 * calendar and Drive tools answer "not available for a Slack account" with the
 * right wording instead of a permission error.
 *
 * `chat` keys on `chat:write` — the one scope every working grant must contain.
 * Slack has no combined read scope (history is four per-conversation-type
 * scopes), so there is no single read scope whose absence would cleanly
 * separate a stale grant from a working one.
 */
export const SLACK_SCOPE_FOR: Record<Capability, string | null> = {
  gmail: null,
  calendar: null,
  drive: null,
  chat: 'chat:write',
};

export const MICROSOFT_TOKEN_ENDPOINT = (authority: string): string =>
  `https://login.microsoftonline.com/${authority}/oauth2/v2.0/token`;

/** The "Add to Slack" authorisation page, and the code-exchange endpoint. */
export const SLACK_AUTHORIZE_ENDPOINT = 'https://slack.com/oauth/v2/authorize';
// The method is dot-separated like every Web API method — a slash here is a
// perfectly plausible typo that Slack answers with a plain 404.
export const SLACK_TOKEN_ENDPOINT = 'https://slack.com/api/oauth.v2.access';

/** Base URL of the Slack Web API; every method is POST/GET under this. */
export const SLACK_API_BASE_URL = 'https://slack.com/api';

export const MICROSOFT_AUTHORIZE_ENDPOINT = (authority: string): string =>
  `https://login.microsoftonline.com/${authority}/oauth2/v2.0/authorize`;

export const GRAPH_BASE_URL = 'https://graph.microsoft.com/v1.0';
