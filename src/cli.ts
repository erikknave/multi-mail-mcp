/**
 * Small admin CLI, mostly for bootstrapping and for when the web UI is not
 * reachable.
 *
 *   npm run cli -- allow <email>          add an address to the sign-in allowlist
 *   npm run cli -- users                  list users
 *   npm run cli -- accounts <email>       list a user's mailboxes and their health
 *   npm run cli -- key <user-email> <name>  issue an API key for an MCP client
 *   npm run cli -- keys <user-email>      list a user's keys
 *   npm run cli -- audit [n]              show the most recent audit entries
 */
import { config } from './config.js';
import { generateApiKey } from './crypto.js';
import { accounts, allowedLogins, apiKeys, audit, recentAudit, users } from './db/repo.js';
import { buildReauthUrl } from './google/oauth.js';

function die(message: string): never {
  console.error(message);
  process.exit(1);
}

function fmtTime(seconds: number | null): string {
  return seconds ? new Date(seconds * 1000).toISOString().slice(0, 16).replace('T', ' ') : '-';
}

const [command, ...args] = process.argv.slice(2);

switch (command) {
  case 'allow': {
    const email = args[0]?.toLowerCase().trim();
    if (!email?.includes('@')) die('Usage: cli allow <email>');
    allowedLogins.add(email, null);
    console.log(`${email} may now sign in at ${config.publicBaseUrl}/`);
    break;
  }

  case 'allowed': {
    const all = allowedLogins.all();
    if (all.length === 0) console.log('(allowlist is empty)');
    for (const a of all) console.log(a.email);
    break;
  }

  case 'users': {
    const all = users.all();
    if (all.length === 0) console.log('(no users yet)');
    for (const u of all) {
      console.log(
        `${u.email.padEnd(32)} ${u.is_admin ? 'admin' : '     '}  last login ${fmtTime(u.last_login)}`,
      );
    }
    break;
  }

  case 'accounts': {
    const email = args[0]?.toLowerCase().trim();
    if (!email) die('Usage: cli accounts <user-email>');
    const user = users.byEmail(email) ?? die(`No such user: ${email}`);

    const all = accounts.forUser(user.id);
    if (all.length === 0) console.log('(no mailboxes connected)');
    for (const a of all) {
      console.log(`${a.email.padEnd(32)} ${a.status.padEnd(13)} last ok ${fmtTime(a.last_ok_at)}`);
      if (a.last_error) console.log(`  error: ${a.last_error}`);
      if (a.status === 'needs_reauth') console.log(`  renew: ${buildReauthUrl(a)}`);
    }
    break;
  }

  case 'key': {
    const email = args[0]?.toLowerCase().trim();
    const name = args.slice(1).join(' ').trim() || 'CLI key';
    if (!email) die('Usage: cli key <user-email> [name]');
    const user = users.byEmail(email) ?? die(`No such user: ${email}`);

    const { key, hash, prefix } = generateApiKey();
    apiKeys.create(user.id, name, hash, prefix);
    audit('apikey.created', { userId: user.id, detail: `${name} (cli)` });

    console.log(`Key for ${user.email} — shown once, store it now:\n`);
    console.log(`  ${key}\n`);
    console.log('Register it with:');
    console.log(`  claude mcp add --transport http multi-mail ${config.publicBaseUrl}/mcp \\`);
    console.log(`    --header "Authorization: Bearer ${key}"`);
    break;
  }

  case 'keys': {
    const email = args[0]?.toLowerCase().trim();
    if (!email) die('Usage: cli keys <user-email>');
    const user = users.byEmail(email) ?? die(`No such user: ${email}`);

    const all = apiKeys.forUser(user.id);
    if (all.length === 0) console.log('(no keys)');
    for (const k of all) {
      console.log(`${k.key_prefix}...  ${k.name.padEnd(24)} last used ${fmtTime(k.last_used_at)}`);
    }
    break;
  }

  case 'audit': {
    const limit = Number(args[0] ?? 30);
    for (const row of recentAudit(Number.isFinite(limit) ? limit : 30).reverse()) {
      console.log(`${fmtTime(row.created_at)}  ${row.action.padEnd(24)} ${row.detail ?? ''}`);
    }
    break;
  }

  default:
    console.log(
      [
        'multi-mail-mcp admin CLI',
        '',
        '  cli allow <email>              allow an address to sign in',
        '  cli allowed                    show the sign-in allowlist',
        '  cli users                      list users',
        '  cli accounts <user-email>      list a user\'s mailboxes and health',
        '  cli key <user-email> [name]    issue an API key for an MCP client',
        '  cli keys <user-email>          list a user\'s API keys',
        '  cli audit [n]                  recent audit log entries',
      ].join('\n'),
    );
    if (command) process.exitCode = 1;
}
