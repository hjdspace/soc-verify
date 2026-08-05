/**
 * certificate-handler tests — certificate error state management.
 *
 * Seam: CertificateErrorTracker class (public interface).
 *
 * Tests verify:
 * - Default state: no proceeding certificates, shouldProceed returns false
 * - allowProceed sets a single-use proceed for a surface+URL
 * - consumeProceed clears the proceed after use (single-continue, no permanent trust)
 * - proceed is scoped to a specific URL, not surface-wide
 * - clearAll resets all state (for cleanup)
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { CertificateErrorTracker } from '../../src/main/browser/certificate-handler';

describe('CertificateErrorTracker', () => {
  let tracker: CertificateErrorTracker;

  beforeEach(() => {
    tracker = new CertificateErrorTracker();
  });

  describe('default behavior', () => {
    it('returns false for shouldProceed on a fresh surface', () => {
      expect(tracker.shouldProceed('surface-1', 'https://example.com')).toBe(false);
    });

    it('returns false for shouldProceed when URL does not match', () => {
      tracker.allowProceed('surface-1', 'https://example.com');
      expect(tracker.shouldProceed('surface-1', 'https://other.com')).toBe(false);
    });
  });

  describe('single-continue', () => {
    it('returns true for shouldProceed after allowProceed', () => {
      tracker.allowProceed('surface-1', 'https://example.com');
      expect(tracker.shouldProceed('surface-1', 'https://example.com')).toBe(true);
    });

    it('clears the proceed after consumeProceed (single-use)', () => {
      tracker.allowProceed('surface-1', 'https://example.com');
      expect(tracker.shouldProceed('surface-1', 'https://example.com')).toBe(true);

      tracker.consumeProceed('surface-1', 'https://example.com');
      expect(tracker.shouldProceed('surface-1', 'https://example.com')).toBe(false);
    });

    it('does not allow proceed for a different URL on the same surface', () => {
      tracker.allowProceed('surface-1', 'https://example.com');
      expect(tracker.shouldProceed('surface-1', 'https://evil.com')).toBe(false);
    });

    it('does not allow proceed for a different surface', () => {
      tracker.allowProceed('surface-1', 'https://example.com');
      expect(tracker.shouldProceed('surface-2', 'https://example.com')).toBe(false);
    });

    it('supports multiple surfaces with independent proceed states', () => {
      tracker.allowProceed('surface-1', 'https://a.com');
      tracker.allowProceed('surface-2', 'https://b.com');
      expect(tracker.shouldProceed('surface-1', 'https://a.com')).toBe(true);
      expect(tracker.shouldProceed('surface-2', 'https://b.com')).toBe(true);

      tracker.consumeProceed('surface-1', 'https://a.com');
      expect(tracker.shouldProceed('surface-1', 'https://a.com')).toBe(false);
      expect(tracker.shouldProceed('surface-2', 'https://b.com')).toBe(true);
    });
  });

  describe('clearAll', () => {
    it('clears all proceed states', () => {
      tracker.allowProceed('surface-1', 'https://a.com');
      tracker.allowProceed('surface-2', 'https://b.com');

      tracker.clearAll();

      expect(tracker.shouldProceed('surface-1', 'https://a.com')).toBe(false);
      expect(tracker.shouldProceed('surface-2', 'https://b.com')).toBe(false);
    });
  });
});
