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

function configPath(projectRoot: string): string {
  return join(projectRoot, SOCVERIFY_DIR, COVERAGE_DIR, EDA_CONFIG_FILE);
}

/**
 * 加载项目级 EDA Tool Configuration。
 * 不存在时返回 null（调用方应提示用户配置）。
 */
export async function loadEdaConfig(projectRoot: string): Promise<EdaToolConfig | null> {
  try {
    const raw = await readFile(configPath(projectRoot), 'utf-8');
    const parsed = JSON.parse(raw) as Partial<EdaToolConfig>;
    if (typeof parsed.tool !== 'string' || typeof parsed.covMergeDir !== 'string') {
      return null;
    }
    return {
      tool: parsed.tool as EdaTool,
      covMergeDir: parsed.covMergeDir,
      summaryCommand: parsed.summaryCommand,
      detailCommand: parsed.detailCommand,
      metricsCommand: parsed.metricsCommand,
      csvCommand: parsed.csvCommand,
      gradeCommand: parsed.gradeCommand,
      binsCommand: parsed.binsCommand,
    };
  } catch {
    return null;
  }
}

/**
 * 保存 EDA Tool Configuration。缺失的命令模板用工具默认值填充。
 */
export async function saveEdaConfig(
  projectRoot: string,
  config: EdaToolConfig,
): Promise<EdaToolConfig> {
  const normalized = normalizeConfig(config);
  const dir = join(projectRoot, SOCVERIFY_DIR, COVERAGE_DIR);
  await mkdir(dir, { recursive: true });
  await writeFile(configPath(projectRoot), JSON.stringify(normalized, null, 2), 'utf-8');
  return normalized;
}

/**
 * 用工具默认命令模板填充缺失字段。unknown 工具无默认，保留 undefined。
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
  };
}
