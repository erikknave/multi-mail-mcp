import { Hono } from 'hono';
import type { Context } from 'hono';
import { encrypt } from '../crypto.js';
import { accounts, audit, users, type User } from '../db/repo.js';
import { currentUser, resolveLogin, startSession } from '../auth.js';
import {
  exchangeCode as exchangeGoogleCode,
  parseOAuthState as parseGoogleState,
} from '../google/oauth.js';
import {
  exchangeCode as exchangeMicrosoftCode,
  microsoftEnabled,
  parseOAuthState as parseMicrosoftState,
} from '../microsoft/oauth.js';
import { consentUrlFor } from '../oauth/consent.js';
import { parseReauthToken } from '../oauth/links.js';
import { providerLabel, type Provider } from '../providers.js';
import { messagePage } from './views.js';

export const oauthRoutes = new Hono();

/**
 * Entry point for a re-auth link handed to a user by an agent.
 *
 * Deliberately usable without an existing web session: the whole point is that
 * the user can click it straight out of a chat window. The link is an HMAC-signed
 * capability with a 24-hour life, and the callback additionally refuses to
 * proceed unless the account that signs in is the expected address.
 *
 * The link carries only an account id, so it keeps working whichever provider
 * that mailbox belongs to — the provider is looked up here, not baked in.
 */
oauthRoutes.get('/reauth/:token', (c) => {
  const parsed = parseReauthToken(c.req.param('token'));
  if (!parsed) {
    return c.html(
      messagePage(
        'Link expired',
        'This renewal link is no longer valid',
        'The link has expired or was altered. Sign in and use the "Renew" button on the dashboard instead.',
        'err',
      ),
      400,
    );
  }

  const account = accounts.byId(parsed.aid);
  if (!account || account.user_id !== parsed.uid) {
    return c.html(
      messagePage('Unknown mailbox', 'Nothing to renew', 'That mailbox is no longer connected.', 'err'),
      404,
    );
  }

  return c.redirect(
    consentUrlFor(account.provider, {
      userId: parsed.uid,
      expectEmail: account.email,
      returnTo: '/',
    }),
  );
});

/* ------------------------------------------------------------------ *
 * Storing a mailbox
 * ------------------------------------------------------------------ */

interface Identity {
  email: string;
  sub: string | null;
  name: string | null;
  refreshToken: string | null;
  accessToken: string;
  accessTokenExpires: number;
  scopes: string;
}

/**
 * The half of both callbacks that is identical: check the grant is renewable,
 * store it, and send the user back to the dashboard.
 */
function storeMailbox(
  c: Context,
  user: User,
  provider: Provider,
  identity: Identity,
): Response | Promise<Response> {
  const existing = accounts.byUserAndEmail(user.id, identity.email);

  if (existing && existing.provider !== provider) {
    return c.html(
      messagePage(
        'Already connected elsewhere',
        `${identity.email} is already connected as a ${providerLabel(existing.provider)} mailbox`,
        `One address can only be connected once. Disconnect the ${providerLabel(existing.provider)} ` +
          `mailbox on the dashboard first if you want to reconnect it through ` +
          `${providerLabel(provider)}.`,
        'err',
      ),
      409,
    );
  }

  if (!identity.refreshToken && !existing?.refresh_token_enc) {
    // Without a refresh token we could not renew access later, so refuse rather
    // than store a mailbox that breaks in an hour.
    const fix =
      provider === 'google'
        ? 'Remove this app at https://myaccount.google.com/permissions and try connecting again.'
        : 'Remove this app at https://myapplications.microsoft.com and try connecting again.';
    return c.html(
      messagePage(
        'Incomplete grant',
        `${providerLabel(provider)} did not return a refresh token`,
        fix,
        'err',
      ),
      400,
    );
  }

  const account = accounts.upsert({
    userId: user.id,
    email: identity.email,
    provider,
    providerSub: identity.sub,
    displayName: identity.name,
    refreshTokenEnc: identity.refreshToken ? encrypt(identity.refreshToken) : null,
    accessTokenEnc: encrypt(identity.accessToken),
    accessTokenExpires: identity.accessTokenExpires,
    scopes: identity.scopes,
  });

  audit(existing ? 'account.renewed' : 'account.connected', {
    userId: user.id,
    accountId: account.id,
    detail: `${identity.email} (${provider})`,
  });

  // If the click came from a re-auth link with no browser session, give them one.
  if (!currentUser(c)) startSession(c, user);

  const verb = existing ? 'renewed' : 'connected';
  return c.redirect(`/?ok=${encodeURIComponent(`${identity.email} ${verb}.`)}`);
}

/* ------------------------------------------------------------------ *
 * Google: sign-in, connect and renew
 * ------------------------------------------------------------------ */

oauthRoutes.get('/oauth/google/callback', async (c) => {
  const error = c.req.query('error');
  if (error) {
    return c.html(
      messagePage('Sign-in cancelled', 'Google returned an error', `Google said: ${error}`, 'err'),
      400,
    );
  }

  const code = c.req.query('code');
  const rawState = c.req.query('state');
  if (!code || !rawState) {
    return c.html(
      messagePage('Bad request', 'Incomplete response from Google', 'Missing code or state.', 'err'),
      400,
    );
  }

  const state = parseGoogleState(rawState);
  if (!state) {
    return c.html(
      messagePage(
        'Session expired',
        'That sign-in attempt timed out',
        'Sign-in links are valid for ten minutes. Please start again.',
        'err',
      ),
      400,
    );
  }

  let identity: Identity;
  try {
    identity = await exchangeGoogleCode(code);
  } catch (err) {
    return c.html(
      messagePage(
        'Sign-in failed',
        'Could not complete the exchange with Google',
        (err as Error).message,
        'err',
      ),
      502,
    );
  }

  // Renewal and re-connect flows pin the expected address, so a user who is
  // signed into several Google accounts cannot silently attach the wrong one.
  if (state.expectEmail && identity.email !== state.expectEmail) {
    return c.html(
      messagePage(
        'Wrong account',
        'That is a different Google account',
        `You signed in as ${identity.email}, but this link is for ${state.expectEmail}. ` +
          `Sign out of Google, or switch account, and open the link again.`,
        'err',
      ),
      400,
    );
  }

  /* --- Work out which user this belongs to --- */

  let userId = state.uid;

  if (!userId) {
    // No user in state: this is a sign-in, so derive the user from the address.
    const outcome = resolveLogin(identity.email, identity.name);
    if (!outcome.ok) {
      return c.html(
        messagePage('Not allowed', 'This account cannot sign in', outcome.reason, 'err'),
        403,
      );
    }
    userId = outcome.user.id;
    startSession(c, outcome.user);
  } else {
    // Connecting or renewing a mailbox: require an active session for that user,
    // except on a signed re-auth link where clicking the link is the authorisation.
    const sessionUser = currentUser(c);
    if (!state.expectEmail && sessionUser?.id !== userId) {
      return c.html(
        messagePage('Signed out', 'Your session ended', 'Please sign in again and retry.', 'err'),
        403,
      );
    }
  }

  const user = users.byId(userId);
  if (!user) {
    return c.html(messagePage('Unknown user', 'Account not found', 'Please sign in again.', 'err'), 404);
  }

  return storeMailbox(c, user, 'google', identity);
});

/* ------------------------------------------------------------------ *
 * Microsoft: connect and renew only
 * ------------------------------------------------------------------ */

/**
 * Microsoft is a way to add a mailbox, never a way to get in.
 *
 * Sign-in stays Google-only, so this callback always requires a user already
 * established in the state — and, unless the state is a signed re-auth link, an
 * active session for that same user. There is no path here that creates a user.
 */
oauthRoutes.get('/oauth/microsoft/callback', async (c) => {
  if (!microsoftEnabled()) {
    return c.html(
      messagePage(
        'Not configured',
        'Microsoft accounts are switched off',
        'This server has no Microsoft app registration configured.',
        'err',
      ),
      404,
    );
  }

  const error = c.req.query('error');
  if (error) {
    const description = c.req.query('error_description') ?? '';
    return c.html(
      messagePage(
        'Connection cancelled',
        'Microsoft returned an error',
        `Microsoft said: ${error}${description ? ` — ${description.split('\n')[0]}` : ''}`,
        'err',
      ),
      400,
    );
  }

  const code = c.req.query('code');
  const rawState = c.req.query('state');
  if (!code || !rawState) {
    return c.html(
      messagePage('Bad request', 'Incomplete response from Microsoft', 'Missing code or state.', 'err'),
      400,
    );
  }

  const state = parseMicrosoftState(rawState);
  if (!state) {
    return c.html(
      messagePage(
        'Session expired',
        'That attempt timed out',
        'Consent links are valid for ten minutes. Please start again.',
        'err',
      ),
      400,
    );
  }

  if (!state.uid) {
    return c.html(
      messagePage(
        'Sign in first',
        'Microsoft cannot be used to sign in',
        'Sign in with Google, then connect your Microsoft mailbox from the dashboard.',
        'err',
      ),
      403,
    );
  }

  const sessionUser = currentUser(c);
  if (!state.expectEmail && sessionUser?.id !== state.uid) {
    return c.html(
      messagePage('Signed out', 'Your session ended', 'Please sign in again and retry.', 'err'),
      403,
    );
  }

  let identity: Identity;
  try {
    identity = await exchangeMicrosoftCode(code);
  } catch (err) {
    return c.html(
      messagePage(
        'Connection failed',
        'Could not complete the exchange with Microsoft',
        (err as Error).message,
        'err',
      ),
      502,
    );
  }

  if (state.expectEmail && identity.email !== state.expectEmail) {
    return c.html(
      messagePage(
        'Wrong account',
        'That is a different Microsoft account',
        `You signed in as ${identity.email}, but this link is for ${state.expectEmail}. ` +
          `Sign out of Microsoft, or switch account, and open the link again.`,
        'err',
      ),
      400,
    );
  }

  const user = users.byId(state.uid);
  if (!user) {
    return c.html(messagePage('Unknown user', 'Account not found', 'Please sign in again.', 'err'), 404);
  }

  return storeMailbox(c, user, 'microsoft', identity);
});
