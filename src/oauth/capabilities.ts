import { GRAPH_SCOPE_FOR, SCOPE_FOR, type Capability } from '../config.js';
import type { Account } from '../db/repo.js';
import { capabilityLabel, providerLabel, PROVIDERS, type Provider } from '../providers.js';
import { ScopeMissingError, UnsupportedForProviderError } from './errors.js';
import { buildReauthUrl } from './links.js';

/**
 * Microsoft returns granted scopes fully qualified — `Mail.ReadWrite` comes
 * back as `https://graph.microsoft.com/Mail.ReadWrite` — and not always in the
 * casing that was requested. Comparing on the last segment, lowercased, is what
 * makes the check answer the question actually being asked.
 */
function normalizeGraphScope(scope: string): string {
  return (scope.split('/').pop() ?? scope).toLowerCase();
}

/** The scope a provider needs for a capability, or null if it has no such thing. */
export function scopeFor(provider: Provider, capability: Capability): string | null {
  return provider === 'microsoft' ? GRAPH_SCOPE_FOR[capability] : SCOPE_FOR[capability];
}

/** Whether a provider offers a capability at all, granted or not. */
export function providerSupports(provider: Provider, capability: Capability): boolean {
  return scopeFor(provider, capability) !== null;
}

/** Whether the stored grant covers a capability. */
export function hasCapability(account: Account, capability: Capability): boolean {
  const needed = scopeFor(account.provider, capability);
  if (!needed) return false;

  const granted = (account.scopes ?? '').split(/\s+/).filter(Boolean);

  if (account.provider === 'microsoft') {
    return granted.map(normalizeGraphScope).includes(normalizeGraphScope(needed));
  }
  return granted.includes(needed);
}

/** Everything an account can actually do right now, for reporting to an agent. */
export function capabilitiesOf(account: Account): Capability[] {
  const all: Capability[] = ['gmail', 'calendar', 'drive', 'chat'];
  return all.filter((capability) => hasCapability(account, capability));
}

/**
 * What to suggest instead when a provider cannot do something at all. Generic
 * wording would be true but useless; naming the way round it is what lets an
 * agent recover on its own.
 */
const ALTERNATIVE: Partial<Record<Capability, string>> = {
  drive: 'Use a connected Google mailbox instead, or ask the user to attach the file to mail.',
  chat: 'Use a connected Microsoft mailbox instead, or reach the person by mail.',
};

/**
 * @throws UnsupportedForProviderError when the provider has no such capability.
 * @throws ScopeMissingError when it does, but this account has not granted it.
 */
export function requireCapability(account: Account, capability: Capability): void {
  if (!providerSupports(account.provider, capability)) {
    const supported = PROVIDERS.filter((p) => providerSupports(p, capability));

    // Named from the perspective of a provider that does offer it, so the
    // message says "Teams chat" rather than "Google Chat" when refusing a
    // Google account.
    const what = capabilityLabel(supported[0] ?? account.provider, capability);
    const hint =
      ALTERNATIVE[capability] ??
      (supported.length
        ? `These tools work only with ${supported.map(providerLabel).join(' or ')} accounts.`
        : 'This server does not implement it for any provider.');

    throw new UnsupportedForProviderError(account.email, account.provider, what, hint);
  }

  if (!hasCapability(account, capability)) {
    throw new ScopeMissingError(
      account.email,
      account.provider,
      capability,
      buildReauthUrl(account),
    );
  }
}
