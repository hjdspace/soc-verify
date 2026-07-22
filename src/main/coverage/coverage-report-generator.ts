/**
 * Coverage Report Generator（ADR 0006 预处理第一步）。
 *
 * 平台根据 EDA Tool Configuration 运行 EDA 工具命令，生成 summary/detail/metrics
 * 三种文本报告到 `.socverify/coverage/<sessionId>/reports/` 目录。
 * 第二步（CoverageParserPlugin 解析）由 CoverageManager 调用插件完成。
 *
 * 命令执行通过 CommandRunner 抽象注入，便于测试 mock。
 */

import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
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
      maxBuffer: 10 * 1024 * 1024,
    });
    return { exitCode: 0, stdout, stderr };
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string };
    return {
      exitCode: e.code ?? 1,
      stdout: e.stdout ?? '',
      stderr: e.stderr ?? '',
    };
  }
};

export interface ReportGeneratorOptions {
  projectRoot: string;
  runner?: CommandRunner;
}

export interface GeneratedReports {
  reportDir: string;
  summaryPath: string;
  detailPath: string;
  metricsPath: string;
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
   */
  async generate(
    config: EdaToolConfig,
    covMergeDir: string,
    sessionId: string,
  ): Promise<GeneratedReports> {
    const reportDir = join(this.projectRoot, '.socverify', 'coverage', sessionId, 'reports');
    await mkdir(reportDir, { recursive: true });

    const substitute = (template: string | undefined): string | null => {
      if (!template) return null;
      return template
        .replaceAll('{covMergeDir}', covMergeDir)
        .replaceAll('{reportDir}', reportDir);
    };

    const summaryCmd = substitute(config.summaryCommand);
    const detailCmd = substitute(config.detailCommand);
    const metricsCmd = substitute(config.metricsCommand);

    const summaryPath = join(reportDir, 'summary.txt');
    const detailPath = join(reportDir, 'detail.txt');
    const metricsPath = join(reportDir, 'metrics.txt');

    const run = async (cmd: string | null): Promise<CommandResult> => {
      if (!cmd) return { exitCode: 0, stdout: '', stderr: '' };
      return this.runner(cmd, { cwd: this.projectRoot });
    };

    const [summaryRes, detailRes, metricsRes] = await Promise.all([
      run(summaryCmd),
      run(detailCmd),
      run(metricsCmd),
    ]);

    const failed = [summaryRes, detailRes, metricsRes].filter((r) => r.exitCode !== 0);
    if (failed.length === 3 && summaryCmd && detailCmd && metricsCmd) {
      // 所有命令都失败且都有模板——抛错让上层处理
      throw new Error(
        `EDA report generation failed: ${failed.map((r) => r.stderr).join('; ')}`,
      );
    }

    return { reportDir, summaryPath, detailPath, metricsPath };
  }
}
