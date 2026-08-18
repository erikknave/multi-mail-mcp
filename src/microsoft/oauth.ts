import {
  config,
  GRAPH_SCOPES,
  MICROSOFT_AUTHORIZE_ENDPOINT,
  MICROSOFT_TOKEN_ENDPOINT,
} from '../config.js';
import { decrypt, encrypt, signToken, verifyToken } from '../crypto.js';
import { now } from '../db/index.js';
import { accounts, audit, type Account } from '../db/repo.js';
import { ReauthRequiredError } from '../oauth/errors.js';
import { buildReauthUrl } from '../oauth/links.js';
import { ServiceError } from '../serviceError.js';

/** Fails loudly rather than producing half-configured URLs. */
export function microsoftConfig(): NonNullable<typeof config.microsoft> {
  if (!config.microsoft) {
    throw new ServiceError(
      'Microsoft accounts are not configured on this server. Set MICROSOFT_CLIENT_ID and ' +
        'MICROSOFT_CLIENT_SECRET (from an Entra ID app registration) and restart.',
    );
  }
  return config.microsoft;
}

export function microsoftEnabled(): boolean {
  return config.microsoft !== null;
}

interface MicrosoftOAuthState extends Record<string, unknown> {
  k: 'ms_oauth_state';
  exp: number;
  uid: string;
  /** When re-authing an existing account, the callback must return this exact address. */
  expectEmail?: string;
  returnTo?: string;
}

/**
 * Builds the Microsoft consent URL.
 *
 * The state kind is distinct from Google's on purpose: a token minted for one
 * provider's callback must not be replayable at the other's, where the code it
 * accompanies would be exchanged against the wrong client credentials.
 */
export function buildConsentUrl(params: {
  userId: string;
  expectEmail?: string;
  returnTo?: string;
}): string {
  const ms = microsoftConfig();

  const state = signToken({
    k: 'ms_oauth_state',
    exp: now() + 600,
    uid: params.userId,
    ...(params.expectEmail ? { expectEmail: params.expectEmail } : {}),
    ...(params.returnTo ? { returnTo: params.returnTo } : {}),
  } satisfies MicrosoftOAuthState);

  const query = new URLSearchParams({
    client_id: ms.clientId,
    response_type: 'code',
    redirect_uri: ms.redirectUri,
    response_mode: 'query',
    scope: GRAPH_SCOPES.join(' '),
    state,
    // Forces the permission screen every time. Without it a user who already
    // consented is bounced straight back, which is fine for a fresh grant but
    // useless for the case that matters: extending permissions after new
    // capabilities were added.
    prompt: 'consent',
    ...(params.expectEmail ? { login_hint: params.expectEmail } : {}),
  });

  return `${MICROSOFT_AUTHORIZE_ENDPOINT(ms.authority)}?${query.toString()}`;
}

export function parseOAuthState(state: string): MicrosoftOAuthState | null {
  return verifyToken<MicrosoftOAuthState>(state, 'ms_oauth_state');
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

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  id_token?: string;
  expires_in?: number;
  scope?: string;
  error?: string;
  error_description?: string;
}

/**
 * Reads the claims out of an id_token without verifying its signature.
 *
 * That is safe here and only here: this token did not arrive from a browser,
 * it came back over TLS from login.microsoftonline.com in direct response to a
 * request carrying our client secret. There is no untrusted party in the path
 * whose forgery a signature check would catch.
 */
function decodeIdTokenClaims(idToken: string): Record<string, unknown> {
  const payload = idToken.split('.')[1];
  if (!payload) return {};
  try {
    return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Record<string, unknown>;
  } catch {
    return {};
  }
}

async function postToken(body: Record<string, string>): Promise<TokenResponse> {
  const ms = microsoftConfig();
  const res = await fetch(MICROSOFT_TOKEN_ENDPOINT(ms.authority), {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: ms.clientId,
      client_secret: ms.clientSecret,
      ...body,
    }),
  });

  const parsed = (await res.json().catch(() => ({}))) as TokenResponse;
  if (!res.ok && !parsed.error) {
    parsed.error = `http_${res.status}`;
  }
  return parsed;
}

export async function exchangeCode(code: string): Promise<ExchangedIdentity> {
  const ms = microsoftConfig();
  const tokens = await postToken({
    grant_type: 'authorization_code',
    code,
    redirect_uri: ms.redirectUri,
    scope: GRAPH_SCOPES.join(' '),
  });

  if (tokens.error || !tokens.access_token) {
    throw new ServiceError(
      `Microsoft refused the sign-in: ${tokens.error ?? 'no access token returned'}` +
        (tokens.error_description ? ` — ${tokens.error_description.split('\n')[0]}` : ''),
    );
  }

  const claims = tokens.id_token ? decodeIdTokenClaims(tokens.id_token) : {};
  let email =
    (typeof claims.email === 'string' ? claims.email : undefined) ??
    (typeof claims.preferred_username === 'string' ? claims.preferred_username : undefined);
  let name = typeof claims.name === 'string' ? claims.name : null;
  const sub = typeof claims.oid === 'string' ? claims.oid : null;

  // The id_token's preferred_username is the sign-in name, which is not always
  // the address mail actually arrives at. /me is authoritative for that, and
  // getting it right matters: the address is how every tool names the mailbox.
  try {
    const res = await fetch('https://graph.microsoft.com/v1.0/me?$select=mail,userPrincipalName,displayName', {
      headers: { authorization: `Bearer ${tokens.access_token}` },
    });
    if (res.ok) {
      const me = (await res.json()) as {
        mail?: string | null;
        userPrincipalName?: string | null;
        displayName?: string | null;
      };
      email = me.mail ?? me.userPrincipalName ?? email;
      name = me.displayName ?? name;
    }
  } catch {
    // Falls back to the id_token claims below.
  }

  if (!email) {
    throw new ServiceError('Could not determine which Microsoft account was authorized.');
  }

  return {
    email: email.toLowerCase(),
    sub,
    name,
    refreshToken: tokens.refresh_token ?? null,
    accessToken: tokens.access_token,
    accessTokenExpires: now() + (tokens.expires_in ?? 3500),
    scopes: tokens.scope ?? GRAPH_SCOPES.join(' '),
  };
}

/* ------------------------------------------------------------------ *
 * Refresh
 * ------------------------------------------------------------------ */

/**
 * Microsoft error codes that mean only a human can fix this. Everything else is
 * treated as transient, so a network blip or a Microsoft outage never marks a
 * perfectly good mailbox as needing re-authentication.
 */
function isFatalTokenError(code: string, description: string): boolean {
  if (code === 'invalid_grant' || code === 'interaction_required' || code === 'unauthorized_client') {
    return true;
  }
  // AADSTS50173 password changed, 700082 refresh token expired,
  // 65001 consent withdrawn, 50076/50079 MFA now required, 700003 revoked.
  return /AADSTS(50173|700082|65001|50076|50079|700003|50058|54005)/.test(description);
}

/** Matches the Google side's window; see google/oauth.ts for why it is this wide. */
const EXPIRY_SKEW = 600;

async function refreshAccessToken(
  account: Account,
): Promise<
  | { accessToken: string; expiresAt: number; refreshToken: string | null }
  | { fatal: string }
  | { transient: string }
> {
  if (!account.refresh_token_enc) return { fatal: 'no refresh token stored' };

  let refreshToken: string;
  try {
    refreshToken = decrypt(account.refresh_token_enc);
  } catch {
    return { fatal: 'stored refresh token could not be decrypted' };
  }

  let tokens: TokenResponse;
  try {
    tokens = await postToken({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      scope: GRAPH_SCOPES.join(' '),
    });
  } catch (err) {
    return { transient: `network error contacting Microsoft: ${(err as Error).message}` };
  }

  if (tokens.error || !tokens.access_token) {
    const code = tokens.error ?? 'no_access_token';
    const desc = tokens.error_description ?? '';
    const detail = `${code}${desc ? `: ${desc.split('\n')[0]}` : ''}`;
    return isFatalTokenError(code, desc) ? { fatal: detail } : { transient: detail };
  }

  return {
    accessToken: tokens.access_token,
    expiresAt: now() + (tokens.expires_in ?? 3600),
    // Microsoft rotates: this is a different token from the one we just sent,
    // and the one we sent is on its way out. Persisting it is not optional.
    refreshToken: tokens.refresh_token ?? null,
  };
}

/**
 * Returns a live Graph access token for the account, refreshing when needed.
 *
 * @throws ReauthRequiredError when the grant is dead and only a human can fix it.
 */
export async function getAccessToken(account: Account): Promise<string> {
  if (
    account.access_token_enc &&
    account.access_token_expires &&
    account.access_token_expires > now() + EXPIRY_SKEW
  ) {
    try {
      return decrypt(account.access_token_enc);
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
    throw new ReauthRequiredError(
      account.email,
      'microsoft',
      buildReauthUrl(account),
      result.fatal,
    );
  }

  if ('transient' in result) {
    throw new Error(
      `Temporary problem refreshing Microsoft access for ${account.email}: ${result.transient}`,
    );
  }

  accounts.updateTokens(
    account.id,
    result.refreshToken ? encrypt(result.refreshToken) : null,
    encrypt(result.accessToken),
    result.expiresAt,
  );
  return result.accessToken;
}

/**
 * Maps an error thrown by a Graph call into a ReauthRequiredError when it
 * indicates a dead or too-narrow grant. Call this in the catch of every Graph
 * call: a token can be revoked between our refresh and the actual request.
 */
export function rethrowAsReauthIfNeeded(err: unknown, account: Account): never {
  const e = err as { status?: number; code?: string; message?: string };
  const status = e?.status;
  const message = e?.message ?? String(err);
  const code = e?.code ?? '';

  // A grant that is alive but too narrow: re-consent fixes it, and it must not
  // be mistaken for a revoked token, which would strip the stored credentials.
  //
  // Matched on what the error says rather than on the 403 alone: Graph also
  // answers 403 for throttling and for mailboxes the user genuinely cannot
  // reach, and sending someone to re-consent over either would waste their time.
  if (
    /ErrorAccessDenied|Access is denied|insufficient privileges|AuthorizationRequestDenied|scope|consent/i.test(
      `${code} ${message}`,
    )
  ) {
    throw new ReauthRequiredError(
      account.email,
      'microsoft',
      buildReauthUrl(account),
      `${message} — the account needs to grant the newer permissions.`,
    );
  }

  if (
    status === 401 ||
    /InvalidAuthenticationToken|CompactToken|token is expired|lifetime validation failed/i.test(
      `${code} ${message}`,
    )
  ) {
    accounts.markNeedsReauth(account.id, message);
    audit('account.reauth_required', {
      userId: account.user_id,
      accountId: account.id,
      detail: message,
    });
    throw new ReauthRequiredError(account.email, 'microsoft', buildReauthUrl(account), message);
  }

  throw err;
}
