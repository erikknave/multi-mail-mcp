import { config } from '../config.js';
import { signToken, verifyToken } from '../crypto.js';
import { now } from '../db/index.js';
import type { Account } from '../db/repo.js';

/**
 * A shareable link that drops the user straight into consent for one account.
 *
 * Provider-agnostic on purpose: the token names an account, and the route that
 * consumes it looks up which provider that account belongs to. That way a link
 * handed out by an agent keeps working no matter which service the mailbox is
 * on.
 */
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
