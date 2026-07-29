import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
import { config } from './config.js';

/* ------------------------------------------------------------------ *
 * Symmetric encryption — for Google refresh tokens at rest
 * ------------------------------------------------------------------ */

/** Encrypts to `v1.<iv>.<tag>.<ciphertext>`, all base64url. */
export function encrypt(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', config.encryptionKey, iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ['v1', iv.toString('base64url'), tag.toString('base64url'), ct.toString('base64url')].join('.');
}

export function decrypt(payload: string): string {
  const parts = payload.split('.');
  if (parts.length !== 4 || parts[0] !== 'v1') {
    throw new Error('Malformed encrypted payload');
  }
  const iv = Buffer.from(parts[1]!, 'base64url');
  const tag = Buffer.from(parts[2]!, 'base64url');
  const ct = Buffer.from(parts[3]!, 'base64url');
  const decipher = createDecipheriv('aes-256-gcm', config.encryptionKey, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}

/* ------------------------------------------------------------------ *
 * API keys
 * ------------------------------------------------------------------ */

/**
 * API keys are high-entropy random strings, so a plain SHA-256 is the right
 * lookup hash — there is nothing to brute-force and we need a deterministic
 * value to index on. (Passwords would need scrypt; we have none.)
 */
export function hashApiKey(key: string): string {
  return createHash('sha256').update(key).digest('base64url');
}

/**
 * 24 random bytes — 192 bits of entropy in a 37-character string including the
 * prefix. Short enough to eyeball and paste by hand, far beyond any brute-force
 * concern. The `mmcp_` prefix makes a leaked key recognisable in logs and in
 * secret scanners.
 */
export function generateApiKey(): { key: string; hash: string; prefix: string } {
  const key = `mmcp_${randomBytes(24).toString('base64url')}`;
  return { key, hash: hashApiKey(key), prefix: key.slice(0, 12) };
}

/* ------------------------------------------------------------------ *
 * Signed capability tokens — attachment URLs, upload URLs, re-auth links
 * ------------------------------------------------------------------ */

export interface TokenPayload {
  /** Token kind, so a download token can never be replayed as a re-auth token. */
  k: string;
  /** Unix seconds expiry. */
  exp: number;
  [key: string]: unknown;
}

/** Produces `<base64url(json)>.<base64url(hmac)>`. URL-safe, no padding. */
export function signToken(payload: TokenPayload): string {
  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const mac = createHmac('sha256', config.urlSigningSecret).update(body).digest('base64url');
  return `${body}.${mac}`;
}

/**
 * Verifies signature, expiry and kind. Returns null on any failure —
 * callers should treat null as 403/404 without distinguishing why.
 */
export function verifyToken<T extends TokenPayload = TokenPayload>(
  token: string,
  expectedKind: string,
): T | null {
  const dot = token.lastIndexOf('.');
  if (dot <= 0) return null;
  const body = token.slice(0, dot);
  const mac = token.slice(dot + 1);

  const expectedMac = createHmac('sha256', config.urlSigningSecret).update(body).digest();
  let providedMac: Buffer;
  try {
    providedMac = Buffer.from(mac, 'base64url');
  } catch {
    return null;
  }
  if (providedMac.length !== expectedMac.length) return null;
  if (!timingSafeEqual(providedMac, expectedMac)) return null;

  let parsed: TokenPayload;
  try {
    parsed = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (parsed.k !== expectedKind) return null;
  if (typeof parsed.exp !== 'number' || parsed.exp < Math.floor(Date.now() / 1000)) return null;
  return parsed as T;
}

/* ------------------------------------------------------------------ *
 * Misc
 * ------------------------------------------------------------------ */

export function randomId(bytes = 16): string {
  return randomBytes(bytes).toString('base64url');
}

/** Constant-time comparison for API keys and similar opaque secrets. */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}
