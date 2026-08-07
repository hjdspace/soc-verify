/**
 * Coverage Merger — coverage database merge logic.
 *
 * Ported from the Python `coverage_merger` plugin.
 * Features: build runsim merge commands, execute with streaming output,
 * configuration history management (load / save / delete / clear).
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { app } from 'electron';

// ── Types ──────────────────────────────────────────────────────────

export type MergeConfig = {
  baseDir: string;
  databases: string[];
  mergeHier: string;
  initialModel: string; // "primary_run" | "empty" | "union_all:cov" | custom path
  mergeWork: string;
  mergeCfg: string;
};

export type HistoryEntry = MergeConfig & {
  command: string;
  timestamp: string;
};

/** Real-time event emitted during merge execution (matches git-quick-pull pattern). */
export type CoverageMergeEvent =
  | { type: 'start'; command: string; lines: string[] }
  | { type: 'output'; line: string }
  | { type: 'end'; success: boolean; lines: string[] };

/** Callback for real-time log streaming. */
export type MergeEventCallback = (event: CoverageMergeEvent) => void;

// ── Command building ───────────────────────────────────────────────

/** Build the runsim merge command string from config. */
export function buildMergeCommand(config: MergeConfig): string {
  const parts = ['runsim'];

  if (config.baseDir) {
    parts.push('-merge_dir', config.baseDir);
  }

  for (const db of config.databases) {
    parts.push(db);
  }

  if (config.mergeHier) {
    parts.push('-merge_hier', config.mergeHier);
  }

  if (config.initialModel) {
    parts.push('-initial_model', config.initialModel);
  }

  if (config.mergeWork) {
    parts.push('-merge_work', config.mergeWork);
  }

  if (config.mergeCfg) {
    parts.push('-merge_cfg', config.mergeCfg);
  }

  return parts.join(' ');
}

/** Format a timestamp string for log entries (matches Python's datetime format). */
function formatTimestamp(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
}

// ── Execution ──────────────────────────────────────────────────────

export type MergeCallbacks = {
  onOutput: (line: string) => void;
  onExit: (code: number | null) => void;
};

/** Execute a merge command with streaming output. Returns the ChildProcess. */
export function executeMerge(
  command: string,
  cwd: string,
  callbacks: MergeCallbacks,
): ChildProcess {
  const proc = spawn(command, {
    cwd,
    shell: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  proc.stdout.on('data', (data) => {
    const text = data.toString();
    for (const line of text.split('\n')) {
      if (line.trim()) callbacks.onOutput(line);
    }
  });

  proc.stderr.on('data', (data) => {
    const text = data.toString();
    for (const line of text.split('\n')) {
      if (line.trim()) callbacks.onOutput(line);
    }
  });

  proc.on('exit', (code) => callbacks.onExit(code));

  return proc;
}

/**
 * Execute a merge command with real-time event streaming (matches Python's
 * pyqtSignal task_progress / task_completed pattern).
 *
 * Emits 'start' → multiple 'output' → 'end' events via `onEvent` callback.
 * Returns the final result with collected logs and success status.
 */
export async function executeMergeStream(
  command: string,
  cwd: string,
  onEvent?: MergeEventCallback,
): Promise<{ success: boolean; logs: string[]; exitCode: number | null }> {
  const logs: string[] = [];

  // Emit start event
  const startLines = [
    `[${formatTimestamp()}] 开始执行覆盖率合并...`,
    `[${formatTimestamp()}] 执行命令：`,
    command,
  ];
  logs.push(...startLines);
  onEvent?.({ type: 'start', command, lines: startLines });

  const success = await new Promise<boolean>((resolve) => {
    executeMerge(command, cwd, {
      onOutput: (line) => {
        const timestamped = `[${formatTimestamp()}] ${line}`;
        logs.push(timestamped);
        onEvent?.({ type: 'output', line: timestamped });
      },
      onExit: (code) => {
        const success = code === 0;
        const endLines: string[] = [];
        if (success) {
          endLines.push(`[${formatTimestamp()}] 覆盖率合并成功完成!`);
        } else {
          endLines.push(`[${formatTimestamp()}] 覆盖率合并失败 (退出码: ${code})`);
        }
        logs.push(...endLines);
        onEvent?.({ type: 'end', success, lines: endLines });
        resolve(success);
      },
    });
  });

  return { success, logs, exitCode: success ? 0 : 1 };
}

// ── History management ─────────────────────────────────────────────

/** Maximum number of history entries to keep (matches Python's limit). */
const MAX_HISTORY = 20;

/**
 * Get the persistent history file path.
 *
 * Uses `app.getPath('userData')` for persistence across restarts
 * (matches the pattern used by project-manager / credential-manager).
 */
function getHistoryPath(): string {
  return join(app.getPath('userData'), 'socverify-coverage-merge-history.json');
}

/** Load merge command history. */
export async function loadHistory(): Promise<HistoryEntry[]> {
  const path = getHistoryPath();
  if (!existsSync(path)) return [];
  try {
    const data = await readFile(path, 'utf-8');
    return JSON.parse(data) as HistoryEntry[];
  } catch {
    return [];
  }
}

/** Save a config to history (deduplicates by baseDir + mergeHier + mergeWork). */
export async function saveHistory(config: MergeConfig): Promise<void> {
  const history = await loadHistory();

  // Remove duplicates (same baseDir, mergeHier, mergeWork — matches Python)
  const filtered = history.filter(
    (h) =>
      h.baseDir !== config.baseDir ||
      h.mergeHier !== config.mergeHier ||
      h.mergeWork !== config.mergeWork,
  );

  // Add new entry at the beginning
  const entry: HistoryEntry = {
    ...config,
    command: buildMergeCommand(config),
    timestamp: new Date().toISOString(),
  };

  filtered.unshift(entry);

  // Keep max 20 entries
  const trimmed = filtered.slice(0, MAX_HISTORY);

  const path = getHistoryPath();
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(trimmed, null, 2), 'utf-8');
}

/** Delete a single history entry by index. */
export async function deleteHistoryItem(index: number): Promise<HistoryEntry[]> {
  const history = await loadHistory();
  if (index < 0 || index >= history.length) return history;

  history.splice(index, 1);

  const path = getHistoryPath();
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(history, null, 2), 'utf-8');

  return history;
}

/** Clear all history entries. */
export async function clearHistory(): Promise<void> {
  const path = getHistoryPath();
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify([], null, 2), 'utf-8');
}

/** Format a command string for display in dropdown (truncates long commands). */
export function formatCommandText(command: string, maxDisplayLength = 80): string {
  if (command.length > maxDisplayLength) {
    return `${command.slice(0, 40)}...${command.slice(-37)}`;
  }
  return command;
}
