/**
 * Which service an account's mail and calendar live in.
 *
 * Sign-in is still Google-only (see auth.ts); this is about where a *mailbox*
 * is hosted, which is a separate question from how the user gets into this
 * service.
 */
export type Provider = 'google' | 'microsoft';

export const PROVIDERS: readonly Provider[] = ['google', 'microsoft'] as const;

export function isProvider(value: string): value is Provider {
  return value === 'google' || value === 'microsoft';
}

/** Human name, for messages a user will read. */
export function providerLabel(provider: Provider): string {
  return provider === 'google' ? 'Google' : 'Microsoft';
}

/** The product name for a capability, so errors name what the user recognises. */
export function capabilityLabel(provider: Provider, capability: string): string {
  const names: Record<string, [string, string]> = {
    // [google name, microsoft name]
    gmail: ['Gmail', 'Outlook mail'],
    calendar: ['Google Calendar', 'Outlook calendar'],
    drive: ['Google Drive', 'OneDrive'],
    chat: ['Google Chat', 'Teams chat'],
  };
  const pair = names[capability];
  if (!pair) return capability;
  return provider === 'google' ? pair[0] : pair[1];
}
