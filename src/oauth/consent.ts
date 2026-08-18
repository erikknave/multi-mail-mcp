import { buildConsentUrl as buildGoogleConsentUrl } from '../google/oauth.js';
import { buildConsentUrl as buildMicrosoftConsentUrl } from '../microsoft/oauth.js';
import type { Provider } from '../providers.js';

/** The consent URL for whichever service hosts a mailbox. */
export function consentUrlFor(
  provider: Provider,
  params: { userId: string; expectEmail?: string; returnTo?: string },
): string {
  return provider === 'microsoft'
    ? buildMicrosoftConsentUrl(params)
    : buildGoogleConsentUrl(params);
}
