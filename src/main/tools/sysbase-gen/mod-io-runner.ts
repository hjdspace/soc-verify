/**
 * Module IO runner for sysbase-gen — executes Verdi's getModIO_batch.p script.
 *
 * Provides:
 *   - resolveVerdiHome: resolve $VERDI_HOME from process.env or .socverify/env.json
 *   - buildModIoCommand: build the perl command string for display
 *   - executeModIo: spawn perl script with streaming stdout/stderr output
 *
 * The script generates a Module IO file from a filelist and module name,
 * used by sysbase_gen.py's `-mod_io` flag.
 */

import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const SOCVERIFY_DIR = '.socverify';
const ENV_CONFIG_FILE = 'env.json';

/** Relative path to getModIO_batch.p from VERDI_HOME. */
const MODIO_SCRIPT_REL = 'share/VIA/Apps/DesignComprehension/GetModIO/getModIO_batch.pl';

/** Default output file name. */
const DEFAULT_OUTPUT_FILE = 'getModIO.log';

/** Real-time event emitted during Module IO generation. */
export type ModIoEvent =
  | { type: 'start'; command: string; lines: string[] }
  | { type: 'output'; line: string }
  | { type: 'end'; success: boolean; lines: string[]; outputFilePath: string };

/** Callback for real-time log streaming. */
export type ModIoEventCallback = (event: ModIoEvent) => void;

/** Result of Module IO generation. */
export type ModIoResult = {
  success: boolean;
  logs: string[];
  outputFilePath: string;
  exitCode: number | null;
};

/**
 * Resolve $VERDI_HOME from process.env, falling back to .socverify/env.json.
 * Returns null if not found in either location.
 */
export function resolveVerdiHome(projectDir?: string): string | null {
  const envVal = process.env.VERDI_HOME;
  if (envVal && envVal.trim()) return envVal.trim();

  if (projectDir) {
    try {
      const configPath = join(projectDir, SOCVERIFY_DIR, ENV_CONFIG_FILE);
      if (!existsSync(configPath)) return null;
      const config = JSON.parse(readFileSync(configPath, 'utf-8')) as {
        envVars?: Record<string, string>;
      };
      const configured = config?.envVars?.VERDI_HOME;
      if (typeof configured === 'string' && configured.trim()) {
        return configured.trim();
      }
    } catch {
      // Config file not found or invalid
    }
  }

  return null;
}

/**
 * Build the getModIO command string for display.
 *
 * @param verdiHome   Resolved VERDI_HOME path
 * @param filelist    Filelist file path
 * @param moduleName  Module name to extract IO from
 * @param outputFile  Output file path (defaults to getModIO.log)
 * @returns Formatted command string
 */
export function buildModIoCommand(
  verdiHome: string,
  filelist: string,
  moduleName: string,
  outputFile?: string,
): string {
  const scriptPath = join(verdiHome, MODIO_SCRIPT_REL);
  const output = outputFile || DEFAULT_OUTPUT_FILE;
  return `perl ${scriptPath} -f ${filelist} -modules "${moduleName}" -o ${output}`;
}

/**
 * Execute the getModIO_batch.p perl script with streaming output.
 *
 * Spawns `perl <VERDI_HOME>/.../getModIO_batch.p -f <filelist> -modules <moduleName> -o <outputFile>`
 * and collects stdout/stderr lines, emitting real-time events via `onEvent`.
 *
 * @param verdiHome   Resolved VERDI_HOME path
 * @param filelist    Filelist file path
 * @param moduleName  Module name to extract IO from
 * @param outputFile  Output file path (defaults to getModIO.log)
 * @param cwd         Working directory for the process
 * @param onEvent     Optional callback for real-time event streaming
 * @returns Result with success status, collected logs, and output file path
 */
export async function executeModIo(
  verdiHome: string,
  filelist: string,
  moduleName: string,
  outputFile: string,
  cwd: string,
  onEvent?: ModIoEventCallback,
): Promise<ModIoResult> {
  const scriptPath = join(verdiHome, MODIO_SCRIPT_REL);
  const command = buildModIoCommand(verdiHome, filelist, moduleName, outputFile);
  const outputFilePath = resolve(cwd, outputFile);

  const logs: string[] = [];
  const startLines = [
    '开始生成 Module IO...',
    '执行命令：',
    command,
  ];
  logs.push(...startLines);
  onEvent?.({ type: 'start', command, lines: startLines });

  const result = await new Promise<ModIoResult>((resolvePromise) => {
    const proc = spawn(
      'perl',
      [scriptPath, '-f', filelist, '-modules', moduleName, '-o', outputFile],
      {
        cwd,
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );

    proc.stdout?.on('data', (data: Buffer) => {
      for (const line of data.toString().split('\n')) {
        const trimmed = line.trim();
        if (trimmed) {
          logs.push(trimmed);
          onEvent?.({ type: 'output', line: trimmed });
        }
      }
    });

    proc.stderr?.on('data', (data: Buffer) => {
      for (const line of data.toString().split('\n')) {
        const trimmed = line.trim();
        if (trimmed) {
          logs.push(trimmed);
          onEvent?.({ type: 'output', line: trimmed });
        }
      }
    });

    proc.on('exit', (code) => {
      const success = code === 0;
      const endLines: string[] = [];
      if (success) {
        endLines.push('Module IO 生成成功!');
        endLines.push(`输出文件: ${outputFilePath}`);
      } else {
        endLines.push(`Module IO 生成失败 (退出码: ${code})`);
      }
      logs.push(...endLines);
      onEvent?.({ type: 'end', success, lines: endLines, outputFilePath });
      resolvePromise({ success, logs, outputFilePath, exitCode: code });
    });

    proc.on('error', (err) => {
      const errorLine = `执行错误: ${err.message}`;
      logs.push(errorLine);
      onEvent?.({ type: 'end', success: false, lines: [errorLine], outputFilePath });
      resolvePromise({ success: false, logs, outputFilePath, exitCode: null });
    });
  });

  return result;
}
