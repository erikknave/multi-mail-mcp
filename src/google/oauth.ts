import { google } from 'googleapis';
import type { OAuth2Client } from 'google-auth-library';
import { config, GOOGLE_SCOPES } from '../config.js';
import { decrypt, encrypt, signToken, verifyToken } from '../crypto.js';
import { accounts, audit, type Account } from '../db/repo.js';
import { now } from '../db/index.js';

const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';

/**
 * Thrown when an account's Google grant is no longer usable and the human must
 * click through consent again. Carries a ready-to-hand-over URL so an agent can
 * simply show `reauthUrl` to the user instead of failing opaquely.
 */
export class ReauthRequiredError extends Error {
  readonly accountEmail: string;
  readonly reauthUrl: string;
  readonly reason: string;

  constructor(accountEmail: string, reauthUrl: string, reason: string) {
    super(
      `Google access for ${accountEmail} has expired and must be renewed. ` +
        `Ask the user to open this link and sign in, then retry: ${reauthUrl}`,
    );
    this.name = 'ReauthRequiredError';
    this.accountEmail = accountEmail;
    this.reauthUrl = reauthUrl;
    this.reason = reason;
  }
}

/* ------------------------------------------------------------------ *
 * Clients and URLs
 * ------------------------------------------------------------------ */

export function newOAuthClient(): OAuth2Client {
  return new google.auth.OAuth2(
    config.google.clientId,
    config.google.clientSecret,
    config.google.redirectUri,
  );
}

interface OAuthState extends Record<string, unknown> {
  k: 'oauth_state';
  exp: number;
  uid: string;
  /** When re-authing an existing account, the callback must return this exact address. */
  expectEmail?: string;
  /** Where to send the browser once the flow completes. */
  returnTo?: string;
}

/**
 * Builds the Google consent URL.
 *
 * `prompt=consent` is deliberate and not optional: without it Google only
 * returns a refresh_token on the very first authorization, so a re-auth would
 * succeed but leave us with no way to refresh afterwards.
 */
export function buildConsentUrl(params: {
  userId: string;
  expectEmail?: string;
  returnTo?: string;
}): string {
  const state = signToken({
    k: 'oauth_state',
    exp: now() + 600,
    uid: params.userId,
    ...(params.expectEmail ? { expectEmail: params.expectEmail } : {}),
    ...(params.returnTo ? { returnTo: params.returnTo } : {}),
  } satisfies OAuthState);

  return newOAuthClient().generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: true,
    scope: [...GOOGLE_SCOPES],
    state,
    ...(params.expectEmail ? { login_hint: params.expectEmail } : {}),
  });
}

export function parseOAuthState(state: string): OAuthState | null {
  return verifyToken<OAuthState>(state, 'oauth_state');
}

/** A shareable link that drops the user straight into consent for one account. */
export function buildReauthUrl(account: Account): string {
  const token = signToken({
    k: 'reauth',
    exp: now() + config.reauthUrlTtl,
    uid: account.user_id,
    aid: account.id,
    email: account.email,
  });
  return `${config.publicBaseUrl}/reauth/${token}`;
}

export function parseReauthToken(
  token: string,
): { uid: string; aid: string; email: string } | null {
  const payload = verifyToken<{ k: string; exp: number; uid: string; aid: string; email: string }>(
    token,
    'reauth',
  );
  if (!payload) return null;
  return { uid: payload.uid, aid: payload.aid, email: payload.email };
}

/* ------------------------------------------------------------------ *
 * Code exchange
 * ------------------------------------------------------------------ */

export interface ExchangedIdentity {
  email: string;
  sub: string | null;
  name: string | null;
  refreshToken: string | null;
  accessToken: string;
  accessTokenExpires: number;
  scopes: string;
}

export async function exchangeCode(code: string): Promise<ExchangedIdentity> {
  const client = newOAuthClient();
  const { tokens } = await client.getToken(code);

  if (!tokens.access_token) {
    throw new Error('Google did not return an access token');
  }

  let email: string | undefined;
  let sub: string | null = null;
  let name: string | null = null;

  if (tokens.id_token) {
    const ticket = await client.verifyIdToken({
      idToken: tokens.id_token,
      audience: config.google.clientId,
    });
    const payload = ticket.getPayload();
    email = payload?.email ?? undefined;
    sub = payload?.sub ?? null;
    name = payload?.name ?? null;
  }

  if (!email) {
    // Fall back to the userinfo endpoint if the id_token was absent or had no email.
    client.setCredentials(tokens);
    const info = await google.oauth2({ version: 'v2', auth: client }).userinfo.get();
    email = info.data.email ?? undefined;
    sub = sub ?? info.data.id ?? null;
    name = name ?? info.data.name ?? null;
  }

  if (!email) {
    throw new Error('Could not determine which Google account was authorized');
  }

  return {
    email: email.toLowerCase(),
    sub,
    name,
    refreshToken: tokens.refresh_token ?? null,
    accessToken: tokens.access_token,
    accessTokenExpires: tokens.expiry_date
      ? Math.floor(tokens.expiry_date / 1000)
      : now() + 3500,
    scopes: tokens.scope ?? GOOGLE_SCOPES.join(' '),
  };
}

/* ------------------------------------------------------------------ *
 * Refresh
 * ------------------------------------------------------------------ */

interface RefreshResponse {
  access_token?: string;
  expires_in?: number;
  scope?: string;
  error?: string;
  error_description?: string;
}

/**
 * Refreshes directly against Google's token endpoint rather than going through
 * the library, so we can distinguish a permanently dead grant (`invalid_grant`,
 * which is what a 7-day testing-mode expiry looks like) from a transient
 * network blip. Only the former should force the user through consent again.
 */
async function refreshAccessToken(
  account: Account,
): Promise<{ accessToken: string; expiresAt: number } | { fatal: string } | { transient: string }> {
  if (!account.refresh_token_enc) {
    return { fatal: 'no refresh token stored' };
  }

  let refreshToken: string;
  try {
    refreshToken = decrypt(account.refresh_token_enc);
  } catch {
    return { fatal: 'stored refresh token could not be decrypted' };
  }

  let res: Response;
  try {
    res = await fetch(TOKEN_ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: config.google.clientId,
        client_secret: config.google.clientSecret,
        refresh_token: refreshToken,
        grant_type: 'refresh_token',
      }),
    });
  } catch (err) {
    return { transient: `network error contacting Google: ${(err as Error).message}` };
  }

  let body: RefreshResponse;
  try {
    body = (await res.json()) as RefreshResponse;
  } catch {
    return { transient: `Google returned a non-JSON response (HTTP ${res.status})` };
  }

  if (!res.ok || !body.access_token) {
    const code = body.error ?? `http_${res.status}`;
    const desc = body.error_description ?? '';
    // invalid_grant covers: refresh token expired (testing-mode 7 days),
    // revoked by the user, or the account's password changed.
    if (code === 'invalid_grant' || code === 'invalid_client' || res.status === 400 || res.status === 401) {
      return { fatal: `${code}${desc ? `: ${desc}` : ''}` };
    }
    return { transient: `${code}${desc ? `: ${desc}` : ''} (HTTP ${res.status})` };
  }

  return {
    accessToken: body.access_token,
    expiresAt: now() + (body.expires_in ?? 3600),
  };
}

/**
 * How long before actual expiry we refresh a cached access token ourselves.
 *
 * This MUST stay above google-auth-library's own eager-refresh threshold
 * (`DEFAULT_EAGER_REFRESH_THRESHOLD_MILLIS`, 5 minutes). If our window is the
 * narrower one, there is a band where we hand the library a token we consider
 * fresh but it considers due for renewal — it then tries to refresh on our
 * behalf and fails. Ten minutes keeps our controlled path comfortably first.
 */
const EXPIRY_SKEW = 600;

/**
 * Returns an OAuth2Client with a live access token for the account, refreshing
 * transparently when needed.
 *
 * The client is always given the refresh token as well as the access token.
 * Without it, any refresh the library decides to perform itself dies with
 * "No refresh token is set." — which surfaces as an opaque failure rather than
 * an actionable one. With it, a library-initiated refresh simply works, and the
 * `tokens` listener persists whatever it obtains so the next call reuses it.
 *
 * @throws ReauthRequiredError when the grant is dead and only a human can fix it.
 */
export async function getAuthorizedClient(account: Account): Promise<OAuth2Client> {
  const client = newOAuthClient();

  let refreshToken: string | null = null;
  if (account.refresh_token_enc) {
    try {
      refreshToken = decrypt(account.refresh_token_enc);
    } catch {
      // Treated as a dead grant below; a token we cannot read is a token we do
      // not have.
      refreshToken = null;
    }
  }

  if (refreshToken) {
    // Persist anything the library refreshes on its own initiative, so a
    // library-side renewal doesn't get thrown away at the end of the request.
    client.on('tokens', (tokens) => {
      if (!tokens.access_token) return;
      try {
        accounts.updateAccessToken(
          account.id,
          encrypt(tokens.access_token),
          tokens.expiry_date ? Math.floor(tokens.expiry_date / 1000) : now() + 3500,
        );
      } catch (err) {
        console.error(`[oauth] could not persist refreshed token for ${account.email}`, err);
      }
    });
  }

  const cached =
    account.access_token_enc && account.access_token_expires
      ? { token: account.access_token_enc, expires: account.access_token_expires }
      : null;

  if (cached && cached.expires > now() + EXPIRY_SKEW) {
    try {
      client.setCredentials({
        access_token: decrypt(cached.token),
        expiry_date: cached.expires * 1000,
        ...(refreshToken ? { refresh_token: refreshToken } : {}),
      });
      return client;
    } catch {
      // Fall through to a refresh if the cached token can't be decrypted.
    }
  }

  const result = await refreshAccessToken(account);

  if ('fatal' in result) {
    accounts.markNeedsReauth(account.id, result.fatal);
    audit('account.reauth_required', {
      userId: account.user_id,
      accountId: account.id,
      detail: result.fatal,
    });
    throw new ReauthRequiredError(account.email, buildReauthUrl(account), result.fatal);
  }

  if ('transient' in result) {
    // Don't flip the account to needs_reauth for something that may fix itself.
    throw new Error(`Temporary problem refreshing Google access for ${account.email}: ${result.transient}`);
  }

  accounts.updateAccessToken(account.id, encrypt(result.accessToken), result.expiresAt);
  client.setCredentials({
    access_token: result.accessToken,
    expiry_date: result.expiresAt * 1000,
    ...(refreshToken ? { refresh_token: refreshToken } : {}),
  });
  return client;
}

/**
 * Maps an error thrown by a Google API call into a ReauthRequiredError when it
 * indicates a dead grant. Call this in the catch of every Gmail/Calendar call:
 * a token can be revoked between our refresh and the actual request.
 */
export function rethrowAsReauthIfNeeded(err: unknown, account: Account): never {
  const e = err as { code?: number; status?: number; message?: string; response?: { status?: number; data?: unknown } };
  const status = e?.code ?? e?.status ?? e?.response?.status;
  const message = e?.message ?? String(err);

  // "No refresh token is set." comes from google-auth-library when it tries to
  // renew a token it was handed without a refresh token. Reaching it means the
  // stored grant is unusable, so treat it as needing re-authentication rather
  // than letting it pass through as an anonymous failure.
  const looksLikeAuthFailure =
    status === 401 ||
    /invalid_grant|invalid credentials|token has been expired or revoked|no refresh token is set|no access, refresh token/i.test(
      message,
    );

  if (looksLikeAuthFailure) {
    accounts.markNeedsReauth(account.id, message);
    audit('account.reauth_required', {
      userId: account.user_id,
      accountId: account.id,
      detail: message,
    });
    throw new ReauthRequiredError(account.email, buildReauthUrl(account), message);
  }

  throw err;
}
