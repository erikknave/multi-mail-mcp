import { buildConsentUrl as buildGoogleConsentUrl } from '../google/oauth.js';
import { buildConsentUrl as buildMicrosoftConsentUrl } from '../microsoft/oauth.js';
import { buildConsentUrl as buildSlackConsentUrl } from '../slack/oauth.js';
import type { Provider } from '../providers.js';

const CONSENT_URL_FOR: Record<Provider, (params: {
  userId: string;
  expectEmail?: string;
  returnTo?: string;
}) => string> = {
  google: buildGoogleConsentUrl,
  microsoft: buildMicrosoftConsentUrl,
  slack: buildSlackConsentUrl,
};

/** The consent URL for whichever service hosts an account. */
export function consentUrlFor(
  provider: Provider,
  params: { userId: string; expectEmail?: string; returnTo?: string },
): string {
  return CONSENT_URL_FOR[provider](params);
}
