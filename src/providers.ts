/**
 * Which service an account lives in.
 *
 * Sign-in is still Google-only (see auth.ts); this is about where a *mailbox*
 * — or, for Slack, a chat workspace membership — is hosted, which is a
 * separate question from how the user gets into this service.
 */
export type Provider = 'google' | 'microsoft' | 'slack';

/**
 * The order is load-bearing: requireCapability names its refusal after the
 * first provider here that offers the capability, so a Google account refused
 * chat says "Teams chat", not "Google Chat" (which this server does not
 * implement).
 */
export const PROVIDERS: readonly Provider[] = ['google', 'microsoft', 'slack'] as const;

export function isProvider(value: string): value is Provider {
  return value === 'google' || value === 'microsoft' || value === 'slack';
}

const LABELS: Record<Provider, string> = {
  google: 'Google',
  microsoft: 'Microsoft',
  slack: 'Slack',
};

/** Human name, for messages a user will read. */
export function providerLabel(provider: Provider): string {
  return LABELS[provider];
}

const CAPABILITY_NAMES: Record<string, Partial<Record<Provider, string>>> = {
  gmail: { google: 'Gmail', microsoft: 'Outlook mail' },
  calendar: { google: 'Google Calendar', microsoft: 'Outlook calendar' },
  drive: { google: 'Google Drive', microsoft: 'OneDrive' },
  chat: { google: 'Google Chat', microsoft: 'Teams chat', slack: 'Slack' },
};

/** The product name for a capability, so errors name what the user recognises. */
export function capabilityLabel(provider: Provider, capability: string): string {
  return CAPABILITY_NAMES[capability]?.[provider] ?? capability;
}
