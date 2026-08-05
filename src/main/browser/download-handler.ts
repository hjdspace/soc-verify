/**
 * download-handler — download state management for Browser sessions.
 *
 * Issue #10: 下载弹出系统保存对话框并提示开始、完成和失败。
 *             取消保存不会留下半成品或错误提示。
 *
 * The DownloadTracker maintains download state and is used to:
 *   1. Track downloads initiated from Browser Surfaces
 *   2. Notify the renderer of start/progress/complete/fail/cancel
 *   3. Clean up completed/failed/cancelled entries
 */

/** Lifecycle state of a download. */
export type DownloadState = 'starting' | 'progressing' | 'completed' | 'failed' | 'cancelled';

/** A single tracked download. */
export type DownloadEntry = {
  id: string;
  filename: string;
  url: string;
  state: DownloadState;
  /** Percentage complete (0–100), or undefined if unknown. */
  percent?: number;
  /** Bytes received so far. */
  receivedBytes?: number;
  /** Total bytes, or undefined if unknown. */
  totalBytes?: number;
  /** Saved file path (set on completion). */
  savedPath?: string;
  /** Error message (set on failure). */
  error?: string;
  /** Timestamp when the download was created. */
  startedAt: number;
};

let downloadCounter = 0;

/**
 * Tracks downloads initiated from Browser Surfaces.
 *
 * Thread-safety: Electron main process is single-threaded for JS execution.
 */
export class DownloadTracker {
  private readonly downloads = new Map<string, DownloadEntry>();

  /** Start tracking a new download. Returns the download ID. */
  startDownload(filename: string, url: string): string {
    const id = `dl-${++downloadCounter}`;
    this.downloads.set(id, {
      id,
      filename,
      url,
      state: 'starting',
      startedAt: Date.now(),
    });
    return id;
  }

  /** Update download progress. */
  progressDownload(id: string, percent: number, receivedBytes: number, totalBytes?: number): void {
    const entry = this.downloads.get(id);
    if (!entry) return;
    entry.state = 'progressing';
    entry.percent = percent;
    entry.receivedBytes = receivedBytes;
    if (totalBytes !== undefined) entry.totalBytes = totalBytes;
  }

  /** Mark a download as completed with the saved file path. */
  completeDownload(id: string, savedPath: string): void {
    const entry = this.downloads.get(id);
    if (!entry) return;
    entry.state = 'completed';
    entry.savedPath = savedPath;
    entry.percent = 100;
  }

  /** Mark a download as failed with an error message. */
  failDownload(id: string, error: string): void {
    const entry = this.downloads.get(id);
    if (!entry) return;
    entry.state = 'failed';
    entry.error = error;
  }

  /** Mark a download as cancelled. */
  cancelDownload(id: string): void {
    const entry = this.downloads.get(id);
    if (!entry) return;
    entry.state = 'cancelled';
  }

  /** Get all tracked downloads. */
  getDownloads(): DownloadEntry[] {
    return [...this.downloads.values()];
  }

  /** Get a specific download by ID. */
  getDownload(id: string): DownloadEntry | undefined {
    return this.downloads.get(id);
  }

  /** Remove completed, failed, and cancelled downloads. */
  clearCompleted(): void {
    for (const [id, entry] of this.downloads) {
      if (entry.state === 'completed' || entry.state === 'failed' || entry.state === 'cancelled') {
        this.downloads.delete(id);
      }
    }
  }
}
