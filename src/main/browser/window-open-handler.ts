/**
 * window-open-handler — classifies and routes window.open calls from Browser Surfaces.
 *
 * Issue #9: 新窗口、SSO/OAuth/MFA 与证书策略
 *
 * Classification rules:
 *   1. Non-http/https URLs → 'deny' (security: block file:, javascript:, data:, etc.)
 *   2. URLs with auth indicators (oauth, sso, login, auth, callback, mfa) AND popup features
 *      (width/height specified) → 'auth-popup' (controlled temporary window preserving opener)
 *   3. All other http/https URLs → 'new-tab' (open as a new browser tab in the workbench)
 */

/** Result of classifying a window.open call. */
export type WindowOpenAction = 'new-tab' | 'auth-popup' | 'deny';

/** URL path patterns that indicate an authentication flow. */
const AUTH_INDICATORS = [
  'oauth',
  'sso',
  'login',
  'signin',
  'sign-in',
  'auth',
  'callback',
  'mfa',
  'verify',
  'authorize',
  'token',
  'openid',
  'saml',
  'cas/',
];

/**
 * Check whether the window features string indicates a popup window
 * (i.e., specifies width and/or height).
 */
function hasPopupFeatures(features: string): boolean {
  return /\b(width|height)\s*=/.test(features);
}

/**
 * Check whether the URL path contains authentication-related indicators.
 * Only the path + query string is checked, not the hostname, to avoid
 * false positives like "auth.example.com" (a content site, not an auth page).
 */
function hasAuthIndicators(url: URL): boolean {
  const pathAndQuery = url.pathname + url.search;
  const lower = pathAndQuery.toLowerCase();
  return AUTH_INDICATORS.some((indicator) => lower.includes(indicator));
}

/**
 * Classify a window.open(url, features) call to determine how to handle it.
 *
 * Returns:
 *   - 'new-tab':    Open as a new browser tab in the workbench
 *   - 'auth-popup': Create a controlled temporary window for authentication
 *   - 'deny':       Block the request entirely
 */
export function classifyWindowOpen(url: string, features: string): WindowOpenAction {
  if (!url || typeof url !== 'string') return 'deny';

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return 'deny';
  }

  // Only allow http and https
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return 'deny';

  // Auth popup: must have BOTH auth indicators in the path AND popup features
  if (hasAuthIndicators(parsed) && hasPopupFeatures(features)) {
    return 'auth-popup';
  }

  return 'new-tab';
}
