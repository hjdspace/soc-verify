// ── Regression command builder ─────────────────────────
// 共享纯函数：回归运行配置模态的命令预览与主进程实际执行共用同一实现，
// 避免出现第二个命令构造器（ADR 0029 决策 6）。

import type { RegressionRunOptions } from './types/regression';

/**
 * Build a `runsim -regr` command string from file path and options.
 *
 * @param filePath   Path to the regression list/group file
 * @param options    Optional execution parameters
 * @returns          Command string, e.g. `runsim -regr /path/to/regr.lst -tag RTL0.1 -cov`
 */
export function buildRegrCommand(filePath: string, options: RegressionRunOptions): string {
  const args: string[] = ['runsim', '-regr', filePath];

  if (options.tags && options.tags.length > 0) {
    args.push('-tag', options.tags.join(','));
  }

  if (options.nonTags && options.nonTags.length > 0) {
    args.push('-nt', options.nonTags.join(','));
  }

  if (options.failMode) {
    args.push('-fm');
  }

  if (options.coverage) {
    args.push('-cov');
  }

  if (options.regrWork) {
    args.push('-regr_work', options.regrWork);
  }

  if (options.merge && options.coverage) {
    args.push('-merge');
  }

  if (options.dashboard) {
    args.push('-m', options.dashboard);
  }

  return args.join(' ');
}
