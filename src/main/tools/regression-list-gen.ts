/**
 * Regression List Generator — generate regression list commands and execute.
 *
 * Ported from the Python `regression_list_gen_plugin` / `gen_regr_list_gui`.
 * Features: build gen_regr_list.py commands, execute via subprocess,
 * save/load history config.
 */

import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

// ── Types ──────────────────────────────────────────────────────────

export type RegressionListConfig = {
  block: string;
  base: string;
  tag: string;
  cfg: string;
  output: string;
  otherOptions: string;
};

export type HistoryEntry = RegressionListConfig & {
  timestamp: string;
};

export type HistoryFile = {
  history: HistoryEntry[];
  current: RegressionListConfig;
};

// ── Command generation ─────────────────────────────────────────────

/** Generate the gen_regr_list.py command from config. */
export function buildCommand(config: RegressionListConfig): string {
  const parts: string[] = ['python gen_regr_list.py'];

  if (config.block) parts.push(`-block ${config.block}`);
  if (config.base) parts.push(`-base ${config.base}`);
  if (config.tag) parts.push(`-tag ${config.tag}`);
  if (config.cfg) parts.push(`-cfg "${config.cfg}"`);
  if (config.output) parts.push(`-o "${config.output}"`);
  if (config.otherOptions) parts.push(config.otherOptions);

  return parts.join(' ');
}

// ── Execution ──────────────────────────────────────────────────────

export type ExecutionCallbacks = {
  onOutput: (line: string) => void;
  onExit: (code: number) => void;
};

/** Execute the gen_regr_list.py command via subprocess. */
export function executeCommand(
  command: string,
  cwd: string,
  callbacks: ExecutionCallbacks,
): void {
  const proc = spawn(command, {
    shell: true,
    cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  proc.stdout?.on('data', (data: Buffer) => {
    const text = data.toString();
    if (text.trim()) callbacks.onOutput(text);
  });

  proc.stderr?.on('data', (data: Buffer) => {
    const text = data.toString();
    if (text.trim()) callbacks.onOutput(text);
  });

  proc.on('exit', (code) => {
    callbacks.onExit(code ?? -1);
  });

  proc.on('error', () => {
    callbacks.onExit(-1);
  });
}

// ── History management ─────────────────────────────────────────────

const HISTORY_DIR = join(homedir(), '.socverify');
const HISTORY_FILE = join(HISTORY_DIR, 'regression-list-gen-config.json');

/** Load history from the config file. */
export async function loadHistory(): Promise<HistoryFile> {
  if (!existsSync(HISTORY_FILE)) {
    return { history: [], current: { block: '', base: '', tag: '', cfg: '', output: '', otherOptions: '' } };
  }

  try {
    const content = await readFile(HISTORY_FILE, 'utf-8');
    return JSON.parse(content) as HistoryFile;
  } catch {
    return { history: [], current: { block: '', base: '', tag: '', cfg: '', output: '', otherOptions: '' } };
  }
}

/** Save history to the config file. */
export async function saveHistory(config: RegressionListConfig): Promise<void> {
  await mkdir(HISTORY_DIR, { recursive: true });

  const existing = await loadHistory();
  const history = existing.history;

  // Check for duplicate
  const dupIndex = history.findIndex(
    (h) =>
      h.block === config.block &&
      h.base === config.base &&
      h.tag === config.tag &&
      h.cfg === config.cfg &&
      h.output === config.output,
  );

  if (dupIndex >= 0) {
    history.splice(dupIndex, 1);
  }

  // Add to front
  const entry: HistoryEntry = {
    ...config,
    timestamp: new Date().toISOString().replace('T', ' ').substring(0, 19),
  };
  history.unshift(entry);

  // Limit to 10 entries
  if (history.length > 10) {
    history.splice(10);
  }

  const data: HistoryFile = { history, current: config };
  await writeFile(HISTORY_FILE, JSON.stringify(data, null, 2), 'utf-8');
}

/** Save current config (without adding to history). */
export async function saveConfig(config: RegressionListConfig): Promise<void> {
  await mkdir(HISTORY_DIR, { recursive: true });

  const existing = await loadHistory();
  const data: HistoryFile = { history: existing.history, current: config };
  await writeFile(HISTORY_FILE, JSON.stringify(data, null, 2), 'utf-8');
}
