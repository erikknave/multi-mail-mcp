import { Hono } from 'hono';
import { encrypt } from '../crypto.js';
import { accounts, audit, users } from '../db/repo.js';
import { currentUser, resolveLogin, startSession } from '../auth.js';
import {
  buildConsentUrl,
  exchangeCode,
  parseOAuthState,
  parseReauthToken,
} from '../google/oauth.js';
import { messagePage } from './views.js';

export const oauthRoutes = new Hono();

/**
 * Entry point for a re-auth link handed to a user by an agent.
 *
 * Deliberately usable without an existing web session: the whole point is that
 * the user can click it straight out of a chat window. The link is an HMAC-signed
 * capability with a 24-hour life, and the callback additionally refuses to
 * proceed unless the Google account that signs in is the expected address.
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
    buildConsentUrl({ userId: parsed.uid, expectEmail: account.email, returnTo: '/' }),
  );
});

/**
 * Single OAuth callback for all three flows: first sign-in, connecting an extra
 * mailbox, and renewing an existing one. Which one it is follows from the state.
 */
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

  const state = parseOAuthState(rawState);
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

  let identity: Awaited<ReturnType<typeof exchangeCode>>;
  try {
    identity = await exchangeCode(code);
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

  /* --- Store the mailbox --- */

  const existing = accounts.byUserAndEmail(user.id, identity.email);

  if (!identity.refreshToken && !existing?.refresh_token_enc) {
    // Without a refresh token we could not renew access later, so refuse rather
    // than store a mailbox that breaks in an hour.
    return c.html(
      messagePage(
        'Incomplete grant',
        'Google did not return a refresh token',
        'Remove this app at https://myaccount.google.com/permissions and try connecting again.',
        'err',
      ),
      400,
    );
  }

  const account = accounts.upsert({
    userId: user.id,
    email: identity.email,
    googleSub: identity.sub,
    displayName: identity.name,
    refreshTokenEnc: identity.refreshToken ? encrypt(identity.refreshToken) : null,
    accessTokenEnc: encrypt(identity.accessToken),
    accessTokenExpires: identity.accessTokenExpires,
    scopes: identity.scopes,
  });

  audit(existing ? 'account.renewed' : 'account.connected', {
    userId: user.id,
    accountId: account.id,
    detail: identity.email,
  });

  // If the click came from a re-auth link with no browser session, give them one.
  if (!currentUser(c)) startSession(c, user);

  const verb = existing ? 'renewed' : 'connected';
  return c.redirect(`/?ok=${encodeURIComponent(`${identity.email} ${verb}.`)}`);
});
