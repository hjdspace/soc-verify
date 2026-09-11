/**
 * EDA Tool Configuration 存储（ADR 0006）。
 *
 * 项目级配置存储在 `.socverify/coverage/eda-config.json`。
 * 指定 EDA 工具类型、cov_merge 默认路径、命令模板。
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import {
  type EdaToolConfig,
  type EdaTool,
  DEFAULT_EDA_COMMANDS,
} from '@shared/types';

const SOCVERIFY_DIR = '.socverify';
const COVERAGE_DIR = 'coverage';
const EDA_CONFIG_FILE = 'eda-config.json';

/** execBackend 缺省值：本地直接执行。 */
const DEFAULT_EXEC_BACKEND = 'direct' as const;
/** EDA 命令启动超时缺省值（秒）。 */
const DEFAULT_STARTUP_TIMEOUT_SEC = 120;
/** EDA 命令运行超时缺省值（秒）。 */
const DEFAULT_RUN_TIMEOUT_SEC = 600;

function configPath(projectRoot: string): string {
  return join(projectRoot, SOCVERIFY_DIR, COVERAGE_DIR, EDA_CONFIG_FILE);
}

/**
 * vcs-urg 历史旧默认值（ADR 0024 修正前的两代默认）：
 *   - 第一代：已发布版本落盘（无 -full64，detail/metrics/csv 为独立命令）
 *   - 第二代：ADR 0021 中间态（含 -full64，detail/metrics/csv 收敛为 undefined）
 * 逐字段匹配：存储值命中任一代旧默认 → 替换为新默认；用户自定义值保留。
 */
const LEGACY_VCS_URG_VALUES: Readonly<
  Record<
    'summaryCommand' | 'detailCommand' | 'metricsCommand' | 'csvCommand' | 'gradeCommand',
    readonly string[]
  >
> = {
  summaryCommand: [
    'urg -dir {covMergeDir} -format text -report {reportDir}',
    'urg -full64 -dir {covMergeDir} -format text -report {reportDir}',
  ],
  detailCommand: ['urg -dir {covMergeDir} -format text -detail -report {reportDir}'],
  metricsCommand: ['urg -dir {covMergeDir} -format text -metrics -report {reportDir}'],
  csvCommand: ['urg -dir {covMergeDir} -format csv -report {reportDir}/csv'],
  gradeCommand: ['urg -dir {covMergeDir} -grade testfile -report {reportDir}'],
};

/** vcs-urg 旧默认 covMergeDir（ADR 0024 修正前，urg 输出目录名，语义颠倒）。 */
const LEGACY_VCS_URG_COV_MERGE_DIR = 'urgReport';

/** imc 旧默认 summary 命令（分层解析优化前）。存量配置命中该值 → 清空，不再执行无信息量的 summary 报告。 */
const LEGACY_IMC_SUMMARY_COMMAND =
  'imc -load {covMergeDir} -execcmd "report -summary -out {reportDir}/summary.txt"';

/**
 * imc 旧配置迁移（分层解析优化）：
 * 存储的 summaryCommand 命中旧默认 → 置为 undefined（新默认）。
 * 用户自定义过的值（不等于旧默认）保留不动。
 */
function migrateLegacyImc(config: EdaToolConfig): EdaToolConfig {
  if (config.tool !== 'imc' || config.summaryCommand !== LEGACY_IMC_SUMMARY_COMMAND) {
    return config;
  }
  return { ...config, summaryCommand: undefined };
}

/**
 * vcs-urg 旧配置迁移（ADR 0024）：
 *   - 存储的 covMergeDir 等于旧默认 'urgReport' → 改为新默认 'cov_merge'
 *   - 存储的命令模板命中任一代旧默认 → 替换为新默认模板
 *     （第一代的 detail/metrics/csv 旧命令在新方案中由 summary 产物或 undefined 取代）
 *   - 用户自定义过的值（不等于任何旧默认）保留不动
 * 仅作用于 vcs-urg；其他工具的 'urgReport' 视为用户自定义值。
 */
function migrateLegacyVcsUrg(config: EdaToolConfig): EdaToolConfig {
  if (config.tool !== 'vcs-urg') {
    return config;
  }
  const next = { ...config };
  const defaults = DEFAULT_EDA_COMMANDS['vcs-urg'];
  if (next.covMergeDir === LEGACY_VCS_URG_COV_MERGE_DIR) {
    next.covMergeDir = defaults.covMergeDir;
  }
  type LegacyCommandField = keyof typeof LEGACY_VCS_URG_VALUES;
  for (const field of Object.keys(LEGACY_VCS_URG_VALUES) as LegacyCommandField[]) {
    const stored = next[field];
    if (stored !== undefined && LEGACY_VCS_URG_VALUES[field].includes(stored)) {
      next[field] = defaults[field];
    }
  }
  return next;
}

/**
 * 加载项目级 EDA Tool Configuration。
 * 不存在时返回 null（调用方应提示用户配置）。
 * 加载时执行 vcs-urg 旧配置迁移（ADR 0024），再按新 schema 补默认字段。
 */
export async function loadEdaConfig(projectRoot: string): Promise<EdaToolConfig | null> {
  try {
    const raw = await readFile(configPath(projectRoot), 'utf-8');
    const parsed = JSON.parse(raw) as Partial<EdaToolConfig>;
    if (typeof parsed.tool !== 'string' || typeof parsed.covMergeDir !== 'string') {
      return null;
    }
    const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
    const num = (v: unknown): number | undefined => (typeof v === 'number' ? v : undefined);
    // 先迁移旧默认值（vcs-urg 两代旧默认 / imc 旧 summary 默认），再用 normalizeConfig 填充缺失字段
    // （防御性：存储的配置可能缺失字段）
    return normalizeConfig(migrateLegacyImc(migrateLegacyVcsUrg({
      tool: parsed.tool as EdaTool,
      covMergeDir: parsed.covMergeDir,
      summaryCommand: str(parsed.summaryCommand),
      detailCommand: str(parsed.detailCommand),
      metricsCommand: str(parsed.metricsCommand),
      csvCommand: str(parsed.csvCommand),
      gradeCommand: str(parsed.gradeCommand),
      binsCommand: str(parsed.binsCommand),
      execBackend: parsed.execBackend === 'lsf' ? 'lsf' : undefined,
      lsfQueue: str(parsed.lsfQueue),
      lsfResource: str(parsed.lsfResource),
      startupTimeoutSec: num(parsed.startupTimeoutSec),
      runTimeoutSec: num(parsed.runTimeoutSec),
    })));
  } catch {
    return null;
  }
}

/** EDA 配置校验错误（调用方可据此映射为用户可见的 BAD_REQUEST）。 */
export class EdaConfigValidationError extends Error {}

/**
 * 保存 EDA Tool Configuration。缺失的命令模板用工具默认值填充。
 * 校验：execBackend='lsf' 时 lsfQueue 必填（ADR 0024）。
 */
export async function saveEdaConfig(
  projectRoot: string,
  config: EdaToolConfig,
): Promise<EdaToolConfig> {
  const normalized = normalizeConfig(config);
  if (normalized.execBackend === 'lsf' && !normalized.lsfQueue?.trim()) {
    throw new EdaConfigValidationError(
      'execBackend 为 "lsf" 时必须配置 lsfQueue（LSF 队列名不能为空）',
    );
  }
  const dir = join(projectRoot, SOCVERIFY_DIR, COVERAGE_DIR);
  await mkdir(dir, { recursive: true });
  await writeFile(configPath(projectRoot), JSON.stringify(normalized, null, 2), 'utf-8');
  return normalized;
}

/**
 * 用工具默认命令模板填充缺失字段。unknown 工具无默认，保留 undefined。
 * 新 schema 字段（execBackend/超时）同时填充默认值（ADR 0024）。
 */
export function normalizeConfig(config: EdaToolConfig): EdaToolConfig {
  if (config.tool === 'unknown') {
    return { ...config };
  }
  const defaults = DEFAULT_EDA_COMMANDS[config.tool];
  return {
    tool: config.tool,
    covMergeDir: config.covMergeDir || defaults.covMergeDir,
    summaryCommand: config.summaryCommand ?? defaults.summaryCommand,
    detailCommand: config.detailCommand ?? defaults.detailCommand,
    metricsCommand: config.metricsCommand ?? defaults.metricsCommand,
    csvCommand: config.csvCommand ?? defaults.csvCommand,
    gradeCommand: config.gradeCommand ?? defaults.gradeCommand,
    binsCommand: config.binsCommand ?? defaults.binsCommand,
    execBackend: config.execBackend ?? DEFAULT_EXEC_BACKEND,
    lsfQueue: config.lsfQueue,
    lsfResource: config.lsfResource,
    startupTimeoutSec: config.startupTimeoutSec ?? DEFAULT_STARTUP_TIMEOUT_SEC,
    runTimeoutSec: config.runTimeoutSec ?? DEFAULT_RUN_TIMEOUT_SEC,
  };
}
