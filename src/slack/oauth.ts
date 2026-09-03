import { config, SLACK_AUTHORIZE_ENDPOINT, SLACK_SCOPES, SLACK_TOKEN_ENDPOINT } from '../config.js';
import { decrypt, signToken, verifyToken } from '../crypto.js';
import { now } from '../db/index.js';
import { accounts, audit, type Account } from '../db/repo.js';
import { ReauthRequiredError } from '../oauth/errors.js';
import { buildReauthUrl } from '../oauth/links.js';
import { ServiceError } from '../serviceError.js';

/** Fails loudly rather than producing half-configured URLs. */
export function slackConfig(): NonNullable<typeof config.slack> {
  if (!config.slack) {
    throw new ServiceError(
      'Slack accounts are not configured on this server. Set SLACK_CLIENT_ID and ' +
        'SLACK_CLIENT_SECRET (from a Slack app at api.slack.com/apps) and restart.',
    );
  }
  return config.slack;
}

export function slackEnabled(): boolean {
  return config.slack !== null;
}

interface SlackOAuthState extends Record<string, unknown> {
  k: 'slack_oauth_state';
  exp: number;
  uid: string;
  /** When re-authing an existing account, the callback must return this exact address. */
  expectEmail?: string;
  returnTo?: string;
}

/**
 * Builds the Slack authorisation URL.
 *
 * The state kind is distinct from the other providers' on purpose: a token
 * minted for one callback must not be replayable at another's, where the code
 * it accompanies would be exchanged against the wrong client credentials.
 *
 * `user_scope`, never `scope`: we want a user token that acts as the member,
 * and no bot at all. Slack shows the requested user scopes on its consent page
 * every time, so there is no `prompt=consent` equivalent to pass.
 */
export function buildConsentUrl(params: {
  userId: string;
  expectEmail?: string;
  returnTo?: string;
}): string {
  const slack = slackConfig();

  const state = signToken({
    k: 'slack_oauth_state',
    exp: now() + 600,
    uid: params.userId,
    ...(params.expectEmail ? { expectEmail: params.expectEmail } : {}),
    ...(params.returnTo ? { returnTo: params.returnTo } : {}),
  } satisfies SlackOAuthState);

  const query = new URLSearchParams({
    client_id: slack.clientId,
    user_scope: SLACK_SCOPES.join(' '),
    redirect_uri: slack.redirectUri,
    state,
  });

  return `${SLACK_AUTHORIZE_ENDPOINT}?${query.toString()}`;
}

export function parseOAuthState(state: string): SlackOAuthState | null {
  return verifyToken<SlackOAuthState>(state, 'slack_oauth_state');
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

interface OAuthAccessResponse {
  ok?: boolean;
  error?: string;
  authed_user?: {
    id?: string;
    access_token?: string;
    scope?: string;
  };
  team?: { id?: string; name?: string };
}

/**
 * Exchanges the authorisation code, then resolves the member's email.
 *
 * The follow-up users.info call plays the role /v1.0/me plays for Microsoft:
 * oauth.v2.access returns no email at all, and the address matters — it is how
 * every tool names the account. Unlike Microsoft there is no id_token to fall
 * back on, so a profile without an email is a hard failure.
 */
export async function exchangeCode(code: string): Promise<ExchangedIdentity> {
  const slack = slackConfig();

  const res = await fetch(SLACK_TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: slack.clientId,
      client_secret: slack.clientSecret,
      redirect_uri: slack.redirectUri,
    }),
  });

  const parsed = (await res.json().catch(() => ({}))) as OAuthAccessResponse;
  const token = parsed.authed_user?.access_token;

  if (!res.ok || parsed.ok === false || !token) {
    const code = parsed.error ?? `http_${res.status}`;
    // Slack evaluates the code before the credentials, so this surfaces only
    // with a real authorization code behind it — the pair in .env is wrong.
    // The Signing Secret is the usual mispaste: same 32-hex shape, next row down.
    if (code === 'bad_client_secret' || code === 'invalid_client_credentials') {
      throw new ServiceError(
        'Slack rejected SLACK_CLIENT_SECRET. Check that it is the Client Secret ' +
          '(Basic Information → App Credentials → Show), not the Signing Secret, and ' +
          'that it comes from the same app as SLACK_CLIENT_ID — then restart the service.',
      );
    }
    throw new ServiceError(`Slack refused the authorisation: ${code}`);
  }

  const userId = parsed.authed_user?.id ?? null;

  let email: string | null = null;
  let name: string | null = null;
  if (userId) {
    const info = await fetch(`https://slack.com/api/users.info?user=${encodeURIComponent(userId)}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    const body = (await info.json().catch(() => ({}))) as {
      ok?: boolean;
      user?: { profile?: { email?: string; real_name?: string }; real_name?: string };
    };
    if (body.ok && body.user) {
      email = body.user.profile?.email ?? null;
      name = body.user.real_name ?? body.user.profile?.real_name ?? null;
    }
  }

  if (!email) {
    throw new ServiceError(
      'Could not determine which Slack account was authorized — the member profile has no ' +
        'email address. The app needs the users:read.email scope.',
    );
  }

  return {
    email: email.toLowerCase(),
    sub: userId ? `${parsed.team?.id ?? ''}/${userId}` : null,
    name,
    // A Slack user token does not expire (unless token rotation is enabled on
    // the app, which this server does not support and the setup tells you to
    // leave off). It is the long-lived credential, stored in the refresh slot;
    // accessTokenExpires is 0 to record "no expiry to cache against".
    refreshToken: token,
    accessToken: token,
    accessTokenExpires: 0,
    scopes: parsed.authed_user?.scope ?? SLACK_SCOPES.join(' '),
  };
}

/* ------------------------------------------------------------------ *
 * Token access
 * ------------------------------------------------------------------ */

/**
 * Returns the stored Slack token.
 *
 * There is no refresh cycle: the token is either present and usable, or the
 * grant is dead (uninstalled, revoked, member deactivated) and a human has to
 * re-authorise. That makes the refresh slot — "the credential we renew from" —
 * simply the credential.
 *
 * @throws ReauthRequiredError when no usable token is stored.
 */
export async function getSlackToken(account: Account): Promise<string> {
  if (!account.refresh_token_enc) {
    return reauth(account, 'no Slack token stored');
  }
  try {
    return decrypt(account.refresh_token_enc);
  } catch {
    return reauth(account, 'stored Slack token could not be decrypted');
  }
}

function reauth(account: Account, reason: string): never {
  accounts.markNeedsReauth(account.id, reason);
  audit('account.reauth_required', { userId: account.user_id, accountId: account.id, detail: reason });
  throw new ReauthRequiredError(account.email, 'slack', buildReauthUrl(account), reason);
}

/**
 * Maps an error thrown by a Slack Web API call into a ReauthRequiredError when
 * it indicates a dead or too-narrow grant. Call this wherever a Slack call can
 * fail: a token can be revoked at any moment, not just between our checks.
 */
export function rethrowAsReauthIfNeeded(err: unknown, account: Account): never {
  const e = err as { status?: number; code?: string; message?: string };
  const code = e?.code ?? '';
  const message = e?.message ?? String(err);

  // A grant that is alive but too narrow — the app's scopes were changed since
  // the account connected. Re-consent fixes it, and it must not be mistaken for
  // a revoked token, which would strip the stored credentials.
  if (code === 'missing_scope') {
    throw new ReauthRequiredError(
      account.email,
      'slack',
      buildReauthUrl(account),
      `${message} — the account needs to grant the newer permissions.`,
    );
  }

  // Slack reports auth failures as HTTP 401 and/or these error strings, often
  // with HTTP 200 and ok:false — which is why the client checks the body first.
  if (
    e?.status === 401 ||
    ['invalid_auth', 'account_inactive', 'token_expired', 'token_revoked'].includes(code)
  ) {
    accounts.markNeedsReauth(account.id, message);
    audit('account.reauth_required', {
      userId: account.user_id,
      accountId: account.id,
      detail: message,
    });
    throw new ReauthRequiredError(account.email, 'slack', buildReauthUrl(account), message);
  }

  throw err;
}
