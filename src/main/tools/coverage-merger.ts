/**
 * Coverage Merger — coverage database merge logic.
 *
 * Ported from the Python `coverage_merger` plugin.
 * Features: build runsim merge commands, execute with streaming output,
 * configuration history management.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

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

// ── History management ─────────────────────────────────────────────

function getHistoryPath(): string {
  return join(tmpdir(), 'socverify-coverage-merge-history.json');
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

/** Save a config to history. */
export async function saveHistory(config: MergeConfig): Promise<void> {
  const history = await loadHistory();

  // Remove duplicates (same baseDir, mergeHier, mergeWork)
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
  const trimmed = filtered.slice(0, 20);

  const path = getHistoryPath();
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, JSON.stringify(trimmed, null, 2), 'utf-8');
}
