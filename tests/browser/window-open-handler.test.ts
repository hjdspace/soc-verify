/**
 * window-open-handler tests — classification of window.open calls.
 *
 * Seam: pure function classifyWindowOpen(url, features).
 *
 * Tests verify:
 * - Normal http/https links without popup features → 'new-tab'
 * - Non-http/https schemes (file:, javascript:, data:) → 'deny'
 * - OAuth/SSO patterns with popup features → 'auth-popup'
 * - noopener flag → still 'new-tab' (no opener relationship)
 * - Empty/null URL → 'deny'
 */
import { describe, it, expect } from 'vitest';
import { classifyWindowOpen } from '../../src/main/browser/window-open-handler';

describe('classifyWindowOpen', () => {
  describe('normal links', () => {
    it('classifies a plain https URL as new-tab', () => {
      expect(classifyWindowOpen('https://example.com', '')).toBe('new-tab');
    });

    it('classifies a plain http URL as new-tab', () => {
      expect(classifyWindowOpen('http://example.com', '')).toBe('new-tab');
    });

    it('classifies a URL with noopener as new-tab', () => {
      expect(classifyWindowOpen('https://example.com', 'noopener')).toBe('new-tab');
    });
  });

  describe('non-http(s) schemes', () => {
    it('denies file: URLs', () => {
      expect(classifyWindowOpen('file:///etc/passwd', '')).toBe('deny');
    });

    it('denies javascript: URLs', () => {
      expect(classifyWindowOpen('javascript:alert(1)', '')).toBe('deny');
    });

    it('denies data: URLs', () => {
      expect(classifyWindowOpen('data:text/html,<script>alert(1)</script>', '')).toBe('deny');
    });

    it('denies about: URLs', () => {
      expect(classifyWindowOpen('about:blank', '')).toBe('deny');
    });

    it('denies empty URL', () => {
      expect(classifyWindowOpen('', '')).toBe('deny');
    });
  });

  describe('auth popup detection', () => {
    it('classifies OAuth authorize URL with popup features as auth-popup', () => {
      const url = 'https://accounts.google.com/oauth/authorize?client_id=xxx&redirect_uri=https://app.com/callback';
      expect(classifyWindowOpen(url, 'width=500,height=600')).toBe('auth-popup');
    });

    it('classifies SSO login URL with popup features as auth-popup', () => {
      const url = 'https://sso.corp.com/login?service=https://app.com';
      expect(classifyWindowOpen(url, 'width=480,height=640,scrollbars=yes')).toBe('auth-popup');
    });

    it('classifies OAuth callback URL with popup features as auth-popup', () => {
      const url = 'https://app.com/auth/callback?code=abc&state=xyz';
      expect(classifyWindowOpen(url, 'width=500,height=600')).toBe('auth-popup');
    });

    it('classifies MFA challenge URL with popup features as auth-popup', () => {
      const url = 'https://auth.corp.com/mfa/verify?session=abc';
      expect(classifyWindowOpen(url, 'width=400,height=500')).toBe('auth-popup');
    });

    it('does NOT classify as auth-popup when URL has no auth indicators', () => {
      // Regular page with popup features → still new-tab (not auth)
      expect(classifyWindowOpen('https://example.com/page', 'width=500,height=600')).toBe('new-tab');
    });

    it('does NOT classify as auth-popup when URL has auth indicators but no popup features', () => {
      const url = 'https://accounts.google.com/oauth/authorize?client_id=xxx';
      // Without popup features (width/height), it's likely a full-page redirect, not a popup
      expect(classifyWindowOpen(url, '')).toBe('new-tab');
    });
  });
});
