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
] as const;
