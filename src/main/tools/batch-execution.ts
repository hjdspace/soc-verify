/**
 * Batch Execution — batch simulation execution logic.
 *
 * Ported from the Python `batch_execution` plugin.
 * Features: parse case files, generate runsim commands,
 * parallel execution with status tracking.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { basename } from 'node:path';

// ── Types ──────────────────────────────────────────────────────────

export type CaseInfo = {
  name: string;
  block: string;
  base: string;
  cfdDef: string;
  file: string;
  path: string;
};

export type ExecutionTask = {
  rowIndex: number;
  caseName: string;
  command: string;
};

export type TaskStatus = 'pending' | 'running' | 'success' | 'failed' | 'unknown';

export type TaskResult = {
  rowIndex: number;
  exitCode: number;
  status: TaskStatus;
  startTime: string;
  endTime: string;
};

// ── Case file parsing ──────────────────────────────────────────────

/**
 * Parse a case config file or regression list file.
 * Supports .txt, .cfg, .list, .lst formats.
 */
export async function parseCaseFile(filePath: string): Promise<CaseInfo[]> {
  if (!existsSync(filePath)) {
    throw new Error(`文件不存在: ${filePath}`);
  }

  const content = await readFile(filePath, 'utf-8');
  const fileName = basename(filePath);
  const ext = filePath.toLowerCase().split('.').pop();

  if (ext === 'list' || ext === 'lst') {
    return parseRegressionList(content, filePath, fileName);
  }

  return parseCaseConfig(content, filePath, fileName);
}

/** Parse a traditional case config file ([case xxx] format). */
function parseCaseConfig(content: string, filePath: string, fileName: string): CaseInfo[] {
  const cases: CaseInfo[] = [];
  const pattern = /\[case\s+([\w_]+)(?:\s*:\s*([\w_]+))?/g;
  let match: RegExpExecArray | null;

  const { base, block } = parseBaseBlockFromPath(filePath);

  while ((match = pattern.exec(content)) !== null) {
    cases.push({
      name: match[1],
      block,
      base,
      cfdDef: '',
      file: fileName,
      path: filePath,
    });
  }

  return cases;
}

/** Parse a regression list file (CSV format). */
function parseRegressionList(content: string, filePath: string, fileName: string): CaseInfo[] {
  const cases: CaseInfo[] = [];
  const lines = content.trim().split('\n');

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('//')) continue;

    const fields = splitCsvLine(trimmed);
    if (fields.length < 3) continue;

    const status = fields[0];
    const blockPath = fields[1];
    const caseName = fields[2];
    const cfgDef = fields.length > 8 ? cleanFieldValue(fields[8]) : '';
    const baseValue = fields.length > 9 ? cleanFieldValue(fields[9]) : '';

    if (status.toUpperCase() !== 'ON') continue;
    if (!blockPath || !caseName) continue;

    cases.push({
      name: caseName,
      block: blockPath,
      base: baseValue.toLowerCase() === 'default' ? '' : baseValue,
      cfdDef: cfgDef.toLowerCase() === 'default' ? '' : cfgDef,
      file: fileName,
      path: filePath,
    });
  }

  return cases;
}

/** Smart CSV split that handles brackets containing commas. */
function splitCsvLine(line: string): string[] {
  // Replace commas inside brackets with a placeholder
  let tempLine = line;
  const replacements: Record<string, string> = {};
  let idx = 0;

  tempLine = tempLine.replace(/\[([^\]]*)\]/g, (match) => {
    const placeholder = `__BRACKET_${idx}__`;
    replacements[placeholder] = match.replace(/,/g, '__COMMA__');
    idx++;
    return placeholder;
  });

  const fields = tempLine.split(',').map((f) => f.trim());

  // Restore bracket content
  return fields.map((f) => {
    let result = f;
    for (const [placeholder, original] of Object.entries(replacements)) {
      if (result.includes(placeholder)) {
        result = result.replace(placeholder, original.replace(/__COMMA__/g, ','));
      }
    }
    return result;
  });
}

function cleanFieldValue(value: string): string {
  const v = value.trim();
  if (v.startsWith('[') && v.endsWith(']')) {
    return v.slice(1, -1).trim();
  }
  return v;
}

function parseBaseBlockFromPath(filePath: string): { base: string; block: string } {
  // Rule 1: dv/{subsys}/bin/case_cfg/xxx_case.cfg
  let match = filePath.match(/dv\/([^/]+)\/bin\/case_cfg\//);
  if (match) return { base: '', block: match[1] };

  // Rule 2: dv/udtb/{subsys}/{subenv}/bin/xxx.cfg
  match = filePath.match(/dv\/udtb\/([^/]+)\/([^/]+)\/bin\//);
  if (match) return { base: match[1], block: `udtb/${match[1]}/${match[2]}` };

  // Rule 3: dv/udtb/usvp/bin/case_cfg/<sys>_subsys_case.cfg
  match = filePath.match(/dv\/udtb\/usvp\/bin\/case_cfg\/([^_]+)_subsys_case\.cfg/);
  if (match) return { base: `${match[1]}_sys`, block: 'udtb/usvp' };

  // Rule 4: dv/udtb/usvp/bin/case_cfg/xxx.cfg
  if (filePath.match(/dv\/udtb\/usvp\/bin\/case_cfg\/.*\.cfg/)) {
    return { base: 'top', block: 'udtb/usvp' };
  }

  return { base: '', block: '' };
}

// ── Command generation ─────────────────────────────────────────────

/** Generate a runsim command for a case. */
export function generateCommand(caseInfo: CaseInfo): string {
  let cmd = `runsim -case ${caseInfo.name}`;
  if (caseInfo.block) cmd += ` -block ${caseInfo.block}`;
  if (caseInfo.base) cmd += ` -base ${caseInfo.base}`;
  if (caseInfo.cfdDef) cmd += ` -cfd_def ${caseInfo.cfdDef}`;
  return cmd;
}

// ── Execution ──────────────────────────────────────────────────────

export type ExecutionCallbacks = {
  onStart: (rowIndex: number, command: string) => void;
  onOutput: (rowIndex: number, output: string) => void;
  onFinish: (rowIndex: number, exitCode: number) => void;
  onAllDone: () => void;
};

/**
 * Batch execution manager — runs commands with configurable parallelism.
 */
export class BatchExecutor {
  private tasks: ExecutionTask[] = [];
  private processes: Map<number, ChildProcess> = new Map();
  private currentIndex = 0;
  private maxParallel = 1;
  private activeCount = 0;
  private stopping = false;
  private callbacks: ExecutionCallbacks;

  constructor(callbacks: ExecutionCallbacks) {
    this.callbacks = callbacks;
  }

  setTasks(tasks: ExecutionTask[]): void {
    this.tasks = tasks;
  }

  setMaxParallel(count: number): void {
    this.maxParallel = Math.max(1, count);
  }

  isRunning(): boolean {
    return this.activeCount > 0 || this.currentIndex < this.tasks.length;
  }

  start(): void {
    this.currentIndex = 0;
    this.activeCount = 0;
    this.stopping = false;
    this.executeNextBatch();
  }

  stop(): void {
    this.stopping = true;
    for (const [_rowIndex, proc] of this.processes) {
      try {
        proc.kill('SIGTERM');
      } catch {
        // Ignore
      }
    }
  }

  private executeNextBatch(): void {
    if (this.stopping) return;

    const available = this.maxParallel - this.activeCount;
    if (available <= 0 || this.currentIndex >= this.tasks.length) {
      if (this.activeCount === 0) {
        this.callbacks.onAllDone();
      }
      return;
    }

    for (let i = 0; i < available && this.currentIndex < this.tasks.length; i++) {
      const task = this.tasks[this.currentIndex];
      this.startProcess(task);
      this.currentIndex++;
      this.activeCount++;
    }
  }

  private startProcess(task: ExecutionTask): void {
    const proc = spawn(task.command, {
      shell: true,
      cwd: process.cwd(),
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this.processes.set(task.rowIndex, proc);
    this.callbacks.onStart(task.rowIndex, task.command);

    const handleData = (data: Buffer) => {
      const text = data.toString();
      if (text.trim()) {
        this.callbacks.onOutput(task.rowIndex, text);
      }
    };

    proc.stdout?.on('data', handleData);
    proc.stderr?.on('data', handleData);

    proc.on('exit', (code) => {
      this.processes.delete(task.rowIndex);
      this.activeCount = Math.max(0, this.activeCount - 1);
      this.callbacks.onFinish(task.rowIndex, code ?? -1);
      this.executeNextBatch();
    });

    proc.on('error', () => {
      this.processes.delete(task.rowIndex);
      this.activeCount = Math.max(0, this.activeCount - 1);
      this.callbacks.onFinish(task.rowIndex, -1);
      this.executeNextBatch();
    });
  }
}

// ── Log status checking ────────────────────────────────────────────

/** Check simulation status from log content. */
export function checkSimStatusFromLog(logPath: string): TaskStatus {
  if (!existsSync(logPath)) return 'unknown';

  try {
    // Use synchronous read for status check (called after process exits)
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs = require('node:fs');
    const content = fs.readFileSync(logPath, 'utf-8');
    const lastLines = content.split('\n').slice(-100).join('\n');

    const passPatterns = ['SPRD_PASSED', 'TEST PASSED', 'PASSED', 'Simulation completed', 'SUCCESS', 'FINISH'];
    for (const p of passPatterns) {
      if (lastLines.includes(p)) return 'success';
    }

    const failPatterns = ['SPRD_FAILED', 'TEST FAILED', 'FAILED', 'Error', 'ERROR', 'FATAL', 'Fatal', 'ABORT', 'TIMEOUT'];
    for (const p of failPatterns) {
      if (lastLines.includes(p)) return 'failed';
    }

    return 'unknown';
  } catch {
    return 'unknown';
  }
}

/** Get the likely log path from a command and case name. */
export function getLogPathFromCommand(command: string, caseName: string): string {
  const parts = command.split(/\s+/);
  let rundir: string | null = null;

  for (let i = 0; i < parts.length; i++) {
    if (parts[i] === '-rundir' && i + 1 < parts.length) {
      rundir = parts[i + 1];
      break;
    }
  }

  const dir = rundir ?? caseName;
  const candidates = [
    `${dir}/log/irun_sim.log`,
    `${dir}/log/vcs_sim.log`,
    `${dir}/log/sim.log`,
    `${caseName}/log/irun_sim.log`,
    `${caseName}/log/vcs_sim.log`,
    `${caseName}/log/sim.log`,
  ];

  for (const p of candidates) {
    if (existsSync(p)) return p;
  }

  return `${dir}/log/irun_sim.log`;
}
