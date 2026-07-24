/**
 * Coverage Report Generator（ADR 0006 预处理第一步）。
 *
 * 平台根据 EDA Tool Configuration 运行 EDA 工具命令，生成 summary/detail/metrics
 * 三种文本报告到 `.socverify/coverage/<sessionId>/reports/` 目录。
 * 第二步（CoverageParserPlugin 解析）由 CoverageManager 调用插件完成。
 *
 * 命令执行通过 CommandRunner 抽象注入，便于测试 mock。
 *
 * Debug 日志：每次命令执行的 stdout/stderr/exitCode 都会写入
 * `.socverify/coverage/<sessionId>/reports/eda-commands.log`，便于排查问题。
 */

import { mkdir, writeFile, appendFile, stat } from 'node:fs/promises';
import { join, resolve, isAbsolute } from 'node:path';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import type { EdaToolConfig } from '@shared/types';

const execAsync = promisify(exec);

export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export type CommandRunner = (
  command: string,
  options: { cwd: string },
) => Promise<CommandResult>;

const defaultRunner: CommandRunner = async (command, options) => {
  try {
    const { stdout, stderr } = await execAsync(command, {
      cwd: options.cwd,
      maxBuffer: 50 * 1024 * 1024,
      env: { ...process.env },
    });
    return { exitCode: 0, stdout, stderr };
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string; message?: string };
    return {
      exitCode: e.code ?? 1,
      stdout: e.stdout ?? '',
      stderr: e.stderr ?? e.message ?? String(err),
    };
  }
};

export interface ReportGeneratorOptions {
  projectRoot: string;
  runner?: CommandRunner;
}

export interface CommandLogEntry {
  name: string;
  command: string;
  cwd: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
}

export interface GeneratedReports {
  reportDir: string;
  summaryPath: string;
  detailPath: string;
  metricsPath: string;
  /** CSV 格式报告路径（urg -format csv 生成） */
  csvPath?: string;
  /** 测试用例贡献度报告路径（urg -grade testfile / imc report -test） */
  gradePath?: string;
  /** Covergroup bin 级报告路径（imc report -bins） */
  binsPath?: string;
  /** EDA 命令执行日志（用于 debug） */
  commandLog: CommandLogEntry[];
  /** 所有命令是否全部失败 */
  allFailed: boolean;
  /** 成功生成的报告文件路径列表 */
  generatedFiles: string[];
}

export class CoverageReportGenerator {
  private projectRoot: string;
  private runner: CommandRunner;

  constructor(opts: ReportGeneratorOptions) {
    this.projectRoot = opts.projectRoot;
    this.runner = opts.runner ?? defaultRunner;
  }

  /**
   * 运行 EDA 命令生成文本报告。
   * 占位符 `{covMergeDir}` 和 `{reportDir}` 会被替换为实际路径。
   * 任一命令模板缺失则跳过该报告（返回空路径），不视为错误。
   *
   * 命令在 covMergeDir 目录下执行（IMC 需要从覆盖率数据库目录启动）。
   * 所有命令的 stdout/stderr 会写入 `eda-commands.log` 文件。
   */
  async generate(
    config: EdaToolConfig,
    covMergeDir: string,
    sessionId: string,
  ): Promise<GeneratedReports> {
    const reportDir = join(this.projectRoot, '.socverify', 'coverage', sessionId, 'reports');
    await mkdir(reportDir, { recursive: true });

    // covMergeDir 解析为绝对路径（相对于 projectRoot）
    const absCovMergeDir = isAbsolute(covMergeDir)
      ? covMergeDir
      : resolve(this.projectRoot, covMergeDir);
    const absReportDir = resolve(reportDir);

    const logPath = join(reportDir, 'eda-commands.log');
    const commandLog: CommandLogEntry[] = [];

    // 初始化日志文件
    await writeFile(
      logPath,
      `=== EDA Report Generation Log ===\n` +
        `Session: ${sessionId}\n` +
        `EDA Tool: ${config.tool}\n` +
        `covMergeDir: ${absCovMergeDir}\n` +
        `reportDir: ${absReportDir}\n` +
        `projectRoot: ${this.projectRoot}\n` +
        `Timestamp: ${new Date().toISOString()}\n` +
        `=================================\n\n`,
      'utf-8',
    );

    const substitute = (template: string | undefined): string | null => {
      if (!template) return null;
      return template
        .replaceAll('{covMergeDir}', absCovMergeDir)
        .replaceAll('{reportDir}', absReportDir);
    };

    const summaryCmd = substitute(config.summaryCommand);
    const detailCmd = substitute(config.detailCommand);
    const metricsCmd = substitute(config.metricsCommand);
    const csvCmd = substitute(config.csvCommand);
    const gradeCmd = substitute(config.gradeCommand);
    const binsCmd = substitute(config.binsCommand);

    const summaryPath = join(reportDir, 'summary.txt');
    const detailPath = join(reportDir, 'detail.txt');
    const metricsPath = join(reportDir, 'metrics.txt');
    // CSV 报告：urg 生成到 {reportDir}/csv/ 目录下
    const csvPath = csvCmd ? join(reportDir, 'csv') : undefined;
    const gradePath = gradeCmd ? join(reportDir, 'grade.txt') : undefined;
    const binsPath = binsCmd ? join(reportDir, 'bins.txt') : undefined;

    // 顺序执行命令（IMC 可能不支持并发访问覆盖率数据库）
    const runAndLog = async (
      name: string,
      cmd: string | null,
    ): Promise<CommandResult> => {
      if (!cmd) {
        const entry: CommandLogEntry = {
          name,
          command: '(skipped — no command template)',
          cwd: absCovMergeDir,
          exitCode: 0,
          stdout: '',
          stderr: '',
          durationMs: 0,
        };
        commandLog.push(entry);
        await appendLog(logPath, entry);
        return { exitCode: 0, stdout: '', stderr: '' };
      }

      const start = Date.now();
      const result = await this.runner(cmd, { cwd: absCovMergeDir });
      const durationMs = Date.now() - start;

      const entry: CommandLogEntry = {
        name,
        command: cmd,
        cwd: absCovMergeDir,
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
        durationMs,
      };
      commandLog.push(entry);
      await appendLog(logPath, entry);

      return result;
    };

    // 顺序执行命令（IMC 可能不支持并发访问覆盖率数据库）
    await runAndLog('summary', summaryCmd);
    await runAndLog('detail', detailCmd);
    await runAndLog('metrics', metricsCmd);
    // 新增：CSV 格式报告（urg -format csv）
    await runAndLog('csv', csvCmd);
    // 新增：测试用例贡献度分析（urg -grade testfile / imc report -test）
    await runAndLog('grade', gradeCmd);
    // 新增：Covergroup bin 级覆盖详情（imc report -bins）
    await runAndLog('bins', binsCmd);

    // 检查哪些报告文件实际生成了
    const generatedFiles: string[] = [];
    const reportFiles: Array<readonly [string, string]> = [
      ['summary', summaryPath],
      ['detail', detailPath],
      ['metrics', metricsPath],
    ];
    if (gradePath) reportFiles.push(['grade', gradePath] as const);
    if (binsPath) reportFiles.push(['bins', binsPath] as const);
    for (const [name, path] of reportFiles) {
      try {
        const info = await stat(path);
        if (info.size > 0) {
          generatedFiles.push(path);
          await appendFile(
            logPath,
            `\n[${name}] File generated: ${path} (${info.size} bytes)\n`,
            'utf-8',
          );
        } else {
          await appendFile(
            logPath,
            `\n[${name}] File exists but is EMPTY: ${path}\n`,
            'utf-8',
          );
        }
      } catch {
        await appendFile(
          logPath,
          `\n[${name}] File NOT generated: ${path}\n`,
          'utf-8',
        );
      }
    }

    const failedCount = commandLog.filter(
      (e) => e.exitCode !== 0 && e.command !== '(skipped — no command template)',
    ).length;
    const totalCommands = commandLog.filter(
      (e) => e.command !== '(skipped — no command template)',
    ).length;
    const allFailed = totalCommands > 0 && failedCount === totalCommands;

    if (allFailed) {
      await appendFile(
        logPath,
        `\n⚠ ALL EDA COMMANDS FAILED. Check stderr above for details.\n`,
        'utf-8',
      );
    }

    // 检查 CSV 目录是否生成了文件
    if (csvPath) {
      try {
        const { readdirSync } = await import('node:fs');
        const csvFiles = readdirSync(csvPath).filter((f) => f.endsWith('.csv'));
        if (csvFiles.length > 0) {
          for (const f of csvFiles) {
            generatedFiles.push(join(csvPath, f));
          }
          await appendFile(logPath, `\n[csv] ${csvFiles.length} CSV files generated in ${csvPath}\n`, 'utf-8');
        } else {
          await appendFile(logPath, `\n[csv] No CSV files found in ${csvPath}\n`, 'utf-8');
        }
      } catch {
        await appendFile(logPath, `\n[csv] CSV directory NOT generated: ${csvPath}\n`, 'utf-8');
      }
    }

    return { reportDir, summaryPath, detailPath, metricsPath, csvPath, gradePath, binsPath, commandLog, allFailed, generatedFiles };
  }
}

/** 将一条命令执行日志追加到日志文件 */
async function appendLog(logPath: string, entry: CommandLogEntry): Promise<void> {
  const text =
    `\n--- ${entry.name} ---\n` +
    `Command: ${entry.command}\n` +
    `CWD: ${entry.cwd}\n` +
    `Exit Code: ${entry.exitCode}\n` +
    `Duration: ${entry.durationMs}ms\n` +
    `--- stdout ---\n${entry.stdout || '(empty)'}\n` +
    `--- stderr ---\n${entry.stderr || '(empty)'}\n`;
  await appendFile(logPath, text, 'utf-8');
}
