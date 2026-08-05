/**
 * download-handler tests — download state management.
 *
 * Seam: DownloadTracker class (public interface).
 *
 * Tests verify:
 * - startDownload creates a tracked download entry
 * - completeDownload marks it as completed
 * - failDownload marks it as failed with an error message
 * - cancelDownload marks it as cancelled
 * - getDownloads returns all tracked downloads
 * - clearCompleted removes completed/failed/cancelled entries
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { DownloadTracker, type DownloadState } from '../../src/main/browser/download-handler';

describe('DownloadTracker', () => {
  let tracker: DownloadTracker;

  beforeEach(() => {
    tracker = new DownloadTracker();
  });

  describe('startDownload', () => {
    it('creates a download entry with "starting" state', () => {
      const id = tracker.startDownload('report.pdf', 'https://example.com/report.pdf');
      const downloads = tracker.getDownloads();
      expect(downloads).toHaveLength(1);
      expect(downloads[0].id).toBe(id);
      expect(downloads[0].filename).toBe('report.pdf');
      expect(downloads[0].state).toBe('starting');
      expect(downloads[0].url).toBe('https://example.com/report.pdf');
    });

    it('generates unique IDs for each download', () => {
      const id1 = tracker.startDownload('a.pdf', 'https://a.com/a.pdf');
      const id2 = tracker.startDownload('b.pdf', 'https://b.com/b.pdf');
      expect(id1).not.toBe(id2);
    });
  });

  describe('completeDownload', () => {
    it('marks a download as completed with the saved path', () => {
      const id = tracker.startDownload('report.pdf', 'https://example.com/report.pdf');
      tracker.completeDownload(id, '/downloads/report.pdf');
      const dl = tracker.getDownloads().find((d) => d.id === id);
      expect(dl?.state).toBe('completed');
      expect(dl?.savedPath).toBe('/downloads/report.pdf');
    });

    it('does not throw for unknown download ID', () => {
      expect(() => tracker.completeDownload('unknown-id', '/path')).not.toThrow();
    });
  });

  describe('failDownload', () => {
    it('marks a download as failed with an error message', () => {
      const id = tracker.startDownload('report.pdf', 'https://example.com/report.pdf');
      tracker.failDownload(id, 'Network error');
      const dl = tracker.getDownloads().find((d) => d.id === id);
      expect(dl?.state).toBe('failed');
      expect(dl?.error).toBe('Network error');
    });
  });

  describe('cancelDownload', () => {
    it('marks a download as cancelled', () => {
      const id = tracker.startDownload('report.pdf', 'https://example.com/report.pdf');
      tracker.cancelDownload(id);
      const dl = tracker.getDownloads().find((d) => d.id === id);
      expect(dl?.state).toBe('cancelled');
    });
  });

  describe('progressDownload', () => {
    it('updates progress for an active download', () => {
      const id = tracker.startDownload('big.zip', 'https://example.com/big.zip');
      tracker.progressDownload(id, 50, 1024);
      const dl = tracker.getDownloads().find((d) => d.id === id);
      expect(dl?.state).toBe('progressing');
      expect(dl?.percent).toBe(50);
      expect(dl?.receivedBytes).toBe(1024);
    });
  });

  describe('clearCompleted', () => {
    it('removes completed, failed, and cancelled downloads', () => {
      const id1 = tracker.startDownload('a.pdf', 'https://a.com/a.pdf');
      const id2 = tracker.startDownload('b.pdf', 'https://b.com/b.pdf');
      const id3 = tracker.startDownload('c.pdf', 'https://c.com/c.pdf');

      tracker.completeDownload(id1, '/downloads/a.pdf');
      tracker.failDownload(id2, 'Timeout');
      tracker.cancelDownload(id3);

      tracker.clearCompleted();
      expect(tracker.getDownloads()).toHaveLength(0);
    });

    it('does not remove starting or progressing downloads', () => {
      const id1 = tracker.startDownload('a.pdf', 'https://a.com/a.pdf');
      const id2 = tracker.startDownload('b.pdf', 'https://b.com/b.pdf');

      tracker.progressDownload(id2, 50, 1024);
      tracker.clearCompleted();

      expect(tracker.getDownloads()).toHaveLength(2);
    });
  });
});
