/**
 * Coverage Recovery 模块（ADR 0025 决策 1 + PRD Issue #03）。
 *
 * 平台（而非 AI）驱动的覆盖率回收流程：
 *   每轮 AI 迭代结束（agent_end + 扫描测试后），平台收集本轮仿真产生的 simv.vdb 路径
 *   + 基线 cov_merge VDB，构造 urg 合并命令（一次读多个 -dir）→ 报告输出到该轮迭代的
 *   round 级报告目录 → 重新解析为 Coverage Tree → 计算真实 Coverage Delta。
 *
 * 关键设计：
 *   - 基线 cov_merge 目录严格只读（合并视图通过 urg 多 VDB 输入实现，不修改用户 merged.vdb）
 *   - 报告输出到 `.socverify/coverage/closure/<closureId>/<targetId>/round_<n>/report/`
 *   - 失败（urg 报错/超时）时返回结构化错误，不静默重试
 *   - 执行经现有 CommandRunner 抽象（direct 模式）或 LSF backend（execBackend=lsf）
 *   - Recovery 结果写入 CoverageManager 数据源，get_coverage Host Tool 返回最新 Recovery 后的覆盖率
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve, isAbsolute } from 'node:path';
import type {
  EdaToolConfig,
  CoverageData,
  CoverageSummary,
  CoverageDelta,
} from '@shared/types';
import { summarizeCoverage, calculateDelta } from '@shared/types';
import { defaultRunner, type CommandRunner, type CommandResult, type ProgressCallback } from './coverage-report-generator';
import type { PluginBackedCoverage } from '../plugin-adapters';
import type { CoverageManager } from './coverage-manager';
import { createLsfRunner, type LsfProgressEvent } from './lsf-runner';

/** Recovery 进度事件（通过 onProgress 回调推送） */
export type RecoveryProgressEvent = {
  step: string;
  message: string;
  percent?: number;
  durationMs?: number;
  details?: Record<string, unknown>;
};

/** Recovery 结果 */
export interface RecoveryResult {
  /** 报告目录路径 */
  reportDir: string;
  /** Recovery 后的 CoverageData */
  data: CoverageData;
  /** Recovery 前的覆盖率摘要 */
  before: CoverageSummary;
  /** Recovery 后的覆盖率摘要 */
  after: CoverageSummary;
  /** 逐 metric delta */
  deltas: CoverageDelta[];
  /** overall delta (after.overall - before.overall) */
  deltaOverall: number;
}

/** Recovery 结构化错误（不静默重试，直接抛出给调用方） */
export class CoverageRecoveryError extends Error {
  readonly phase: string;
  readonly exitCode?: number;
  readonly stderr?: string;

  constructor(
    phase: string,
    message: string,
    opts?: { exitCode?: number; stderr?: string },
  ) {
    super(message);
    this.name = 'CoverageRecoveryError';
    this.phase = phase;
    this.exitCode = opts?.exitCode;
    this.stderr = opts?.stderr;
  }
}

/** Recovery 输入参数 */
export interface RecoveryInput {
  /** 项目根目录 */
  projectRoot: string;
  /** 基线 cov_merge VDB 目录（只读） */
  baselineVdbDir: string;
  /** 本轮仿真产生的 VDB 路径列表 */
  newVdbPaths: string[];
  /** EDA Tool Configuration（含命令模板 + execBackend 配置） */
  edaConfig: EdaToolConfig;
  /** 报告输出目录（round 级，如 .../round_1/report/） */
  reportDir: string;
  /** 关联的 Coverage Merge Session ID（用于解析器 enrichment） */
  sessionId: string;
  /** 当前生效的 Coverage Target 配置 */
  targets: Partial<Record<string, number>>;
  /** Recovery 前的覆盖率摘要（用于 delta 计算） */
  before: CoverageSummary;
  /** Coverage adapter（用于解析报告） */
  coverageAdapter: PluginBackedCoverage;
  /** 可选的 CommandRunner（direct 模式；测试注入 mock） */
  runner?: CommandRunner;
  /** 可选的进度回调 */
  onProgress?: ProgressCallback;
}

/**
 * 构造多 VDB 合并 urg 命令。
 *
 * urg 合并多个 VDB 的命令形态：
 *   urg -full64 -dir <baseline> -dir <vdb1> -dir <vdb2> ... -xml_verbose -format text -show summary -report <reportDir>
 *
 * 基线 VDB 只作为 -dir 输入，不被修改（urg 合并是只读操作）。
 * 若 edaConfig.summaryCommand 存在自定义模板，则用占位符替换方式构造（支持 {covMergeDir} {reportDir}），
 * 但 Recovery 需要多 -dir 输入，因此自定义模板中单个 {covMergeDir} 会被替换为多个 -dir 参数。
 */
export function buildMergeCommand(
  baselineVdbDir: string,
  newVdbPaths: string[],
  edaConfig: EdaToolConfig,
  reportDir: string,
): string {
  // 所有 VDB 路径（基线 + 新仿真产生的）
  const allDirs = [baselineVdbDir, ...newVdbPaths];
  const multiDirArg = allDirs.map((d) => `-dir "${d}"`).join(' ');

  // 构造 urg summary 命令（-xml_verbose 生成 session.xml + -show summary 生成 summary 文本）
  // 使用与 DEFAULT_EDA_COMMANDS['vcs-urg'].summaryCommand 一致的形态，但 -dir 改为多 VDB 输入
  const tool = edaConfig.tool;
  if (tool === 'vcs-urg') {
    // 如果用户自定义了 summaryCommand，尝试替换 {covMergeDir} 为多 -dir 参数
    const template = edaConfig.summaryCommand;
    if (template && template.includes('{covMergeDir}')) {
      return template
        .replaceAll('{covMergeDir}', allDirs.map((d) => `"${d}"`).join(' -dir '))
        .replaceAll('{reportDir}', reportDir);
    }
    // 默认形态：urg -full64 -dir <vdb1> -dir <vdb2> ... -xml_verbose -format text -show summary -report <reportDir>
    return `urg -full64 ${multiDirArg} -xml_verbose -format text -show summary -report "${reportDir}"`;
  }

  // 非 vcs-urg 工具：使用模板替换（IMC/vcover 可能不支持多 VDB，但走通用路径）
  const template = edaConfig.summaryCommand;
  if (template) {
    return template
      .replaceAll('{covMergeDir}', baselineVdbDir)
      .replaceAll('{reportDir}', reportDir);
  }

  // 无可用模板
  throw new CoverageRecoveryError(
    'command_construction',
    `无法为 EDA 工具 ${tool} 构造 Recovery 合并命令：缺少 summaryCommand 模板`,
  );
}

/**
 * 执行 Coverage Recovery。
 *
 * 流程：
 *   1. 创建报告输出目录
 *   2. 构造多 VDB 合并 urg 命令
 *   3. 通过 CommandRunner（direct 或 LSF）执行命令
 *   4. 通过 CoverageAdapter 解析报告为 CoverageData
 *   5. 计算真实 Delta（after vs before）
 *   6. 将 Recovery 结果写入 CoverageManager 缓存（get_coverage 可见）
 *
 * 失败处理：urg 报错/超时 → 抛出 CoverageRecoveryError，不静默重试。
 */
export async function executeRecovery(input: RecoveryInput): Promise<RecoveryResult> {
  const {
    projectRoot,
    baselineVdbDir,
    newVdbPaths,
    edaConfig,
    reportDir,
    sessionId,
    targets,
    before,
    coverageAdapter,
    runner: customRunner,
    onProgress,
  } = input;

  // Step 0: 创建报告输出目录
  onProgress?.({
    step: 'recovery_init',
    message: '正在初始化 Coverage Recovery...',
    percent: 0,
  });
  await mkdir(reportDir, { recursive: true });

  // 写入 meta.json（解析器需要）
  const absBaseline = isAbsolute(baselineVdbDir)
    ? baselineVdbDir
    : resolve(projectRoot, baselineVdbDir);
  await writeFile(
    join(reportDir, 'meta.json'),
    JSON.stringify({
      covMergeDir: absBaseline,
      edaTool: edaConfig.tool,
      createdAt: Date.now(),
      recovery: true,
      newVdbPaths,
    }, null, 2),
    'utf-8',
  );

  // Step 1: 构造合并命令
  onProgress?.({
    step: 'recovery_command',
    message: `正在构造 urg 合并命令（${1 + newVdbPaths.length} 个 VDB 输入）...`,
    percent: 10,
  });
  const command = buildMergeCommand(baselineVdbDir, newVdbPaths, edaConfig, reportDir);

  // Step 2: 执行 urg 命令（direct 或 LSF backend）
  onProgress?.({
    step: 'recovery_eda',
    message: '正在执行 urg 合并生成 Recovery 报告...',
    percent: 15,
  });

  const runner = customRunner ?? resolveRunner(edaConfig, projectRoot, onProgress);
  const result: CommandResult = await runner(command, { cwd: absBaseline });

  if (result.exitCode !== 0) {
    throw new CoverageRecoveryError(
      'eda_execution',
      `urg Recovery 合并命令执行失败（exitCode=${result.exitCode}）: ${result.stderr || result.stdout || '未知错误'}`,
      { exitCode: result.exitCode, stderr: result.stderr },
    );
  }

  // Step 3: 解析报告
  onProgress?.({
    step: 'recovery_parsing',
    message: '正在解析 Recovery 报告为覆盖率树...',
    percent: 60,
  });
  const workerResult = await coverageAdapter.parse(sessionId, reportDir, {
    sessionId,
    covMergeDir: absBaseline,
    edaTool: edaConfig.tool,
    targets,
    summaryOnly: true,
  });
  const data = workerResult.data;

  // Step 4: 计算 Delta
  onProgress?.({
    step: 'recovery_delta',
    message: '正在计算 Coverage Delta...',
    percent: 85,
  });
  const after = summarizeCoverage(data.root);
  const deltas = calculateDelta(before, after);
  const deltaOverall = after.overall - before.overall;

  onProgress?.({
    step: 'recovery_done',
    message: `Recovery 完成（overall delta: ${deltaOverall >= 0 ? '+' : ''}${deltaOverall.toFixed(2)}%）`,
    percent: 100,
  });

  return {
    reportDir,
    data,
    before,
    after,
    deltas,
    deltaOverall,
  };
}

/**
 * 根据 edaConfig.execBackend 选择合适的 CommandRunner。
 * - direct（默认）：使用 spawn-based default runner（现有行为）
 * - lsf：使用 LSF runner（bsub -K 提交，超时 bkill，fail-closed 不回退）
 *
 * 注意：LSF runner 的超时使用 edaConfig 中的 startupTimeoutSec / runTimeoutSec。
 */
function resolveRunner(
  edaConfig: EdaToolConfig,
  projectRoot: string,
  onProgress?: ProgressCallback,
): CommandRunner {
  const execBackend = edaConfig.execBackend ?? 'direct';

  if (execBackend === 'lsf') {
    // LSF 模式：通过 createLsfRunner 构造 bsub -K runner
    const lsfProgress = (event: LsfProgressEvent): void => {
      onProgress?.({
        step: event.phase,
        message: event.message,
        percent: event.percent,
        details: event.details,
      });
    };
    return createLsfRunner({
      queue: edaConfig.lsfQueue!,
      resource: edaConfig.lsfResource,
      startupTimeoutSec: edaConfig.startupTimeoutSec ?? 120,
      runTimeoutSec: edaConfig.runTimeoutSec ?? 600,
      onProgress: lsfProgress,
    });
  }

  // direct 模式：使用 spawn-based default runner（已从 coverage-report-generator 导入）
  return defaultRunner;
}

/**
 * 将 Recovery 结果写入 CoverageManager 缓存。
 *
 * Recovery 后的 CoverageData 替换 CoverageManager 中对应 sessionId 的缓存数据，
 * 使 get_coverage / getCoverageSummary / getTree 等 Host Tool 与 API 返回最新 Recovery 结果。
 */
export async function persistRecoveryResult(
  coverageManager: CoverageManager,
  result: RecoveryResult,
): Promise<void> {
  // 使用 cache 方法（内部调用）——通过 cast 访问 private 方法
  // CoverageManager.cache 是 private，但 Recovery 需要更新缓存
  // 最佳方式：在 CoverageManager 上新增 public 方法，或通过 cast 访问
  // 这里通过 cast 访问 cache 方法（与现有代码模式一致）
  const mgr = coverageManager as unknown as {
    cache: (data: CoverageData) => Promise<void>;
  };
  await mgr.cache(result.data);
}
