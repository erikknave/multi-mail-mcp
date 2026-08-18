import type { Capability } from '../config.js';
import { capabilityLabel, providerLabel, type Provider } from '../providers.js';

/**
 * Thrown when an account's grant is no longer usable and the human must click
 * through consent again. Carries a ready-to-hand-over URL so an agent can
 * simply show `reauthUrl` to the user instead of failing opaquely.
 */
export class ReauthRequiredError extends Error {
  readonly accountEmail: string;
  readonly provider: Provider;
  readonly reauthUrl: string;
  readonly reason: string;

  constructor(accountEmail: string, provider: Provider, reauthUrl: string, reason: string) {
    super(
      `${providerLabel(provider)} access for ${accountEmail} has expired and must be renewed. ` +
        `Ask the user to open this link and sign in, then retry: ${reauthUrl}`,
    );
    this.name = 'ReauthRequiredError';
    this.accountEmail = accountEmail;
    this.provider = provider;
    this.reauthUrl = reauthUrl;
    this.reason = reason;
  }
}

/**
 * Thrown when the account's grant is alive but predates a capability we now
 * need — for example a mailbox connected before Drive support existed. Both
 * providers answer those calls with an opaque 403, so we detect the gap up
 * front and tell the user exactly what to do about it.
 */
export class ScopeMissingError extends Error {
  readonly accountEmail: string;
  readonly provider: Provider;
  readonly capability: Capability;
  readonly reauthUrl: string;

  constructor(
    accountEmail: string,
    provider: Provider,
    capability: Capability,
    reauthUrl: string,
  ) {
    super(
      `${accountEmail} has not granted ${capabilityLabel(provider, capability)} access. It was ` +
        `connected before this capability existed, so its permission needs extending. Ask the ` +
        `user to open this link and approve: ${reauthUrl}`,
    );
    this.name = 'ScopeMissingError';
    this.accountEmail = accountEmail;
    this.provider = provider;
    this.capability = capability;
    this.reauthUrl = reauthUrl;
  }
}

/**
 * Thrown when a tool is asked to do something the account's provider does not
 * offer at all — Drive, Sheets and Docs against a Microsoft mailbox.
 *
 * This is deliberately a distinct error from ScopeMissingError. Re-consenting
 * would not help, so telling the user to click a renewal link would send them
 * on an errand that cannot succeed.
 */
export class UnsupportedForProviderError extends Error {
  readonly accountEmail: string;
  readonly provider: Provider;

  constructor(accountEmail: string, provider: Provider, what: string, alternative?: string) {
    super(
      `${what} is not available for ${accountEmail}, which is a ${providerLabel(provider)} ` +
        `account.` + (alternative ? ` ${alternative}` : ''),
    );
    this.name = 'UnsupportedForProviderError';
    this.accountEmail = accountEmail;
    this.provider = provider;
  }
}
