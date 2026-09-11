/**
 * AI Exclusion 建议模型与解析（ADR 0026 决策 1 / PRD Issue #07）。
 *
 * AI 在 Triage 升级时，对判定为 dead_code / 不可达根因的 gap 输出 exclusion 建议：
 *   语义 selector（module + metric + file/line 或 bin 名）+ 必填 reason + AI 置信度。
 * 建议状态固定 pending、来源固定 'ai-triage'——AI 任何情况下只能建议、不能排除
 * （安全底线，见 PRD US-33；approve/reject 只能人工触发）。
 *
 * AI 输出约定：在回复文本中以 ```exclusion-suggestions JSON 代码块给出建议数组，
 * 字段：module / metric / file / line / bin / reason / confidence。
 */

import type { CoverageMetric } from '@shared/types';
import { COVERAGE_METRICS } from '@shared/types';

/** AI 建议来源标识（固定值，禁止其他来源冒用 ai-triage 名义）。 */
export const EXCLUSION_REQUESTED_BY = 'ai-triage' as const;

/** AI Exclusion 建议（语义 selector + 必填 reason + 置信度，状态固定 pending）。 */
export type ExclusionSuggestion = {
  /** 目标模块路径（Coverage Tree 中的 nodePath，如 tb_top.chip_top） */
  module: string;
  metric: CoverageMetric;
  /** file/line 形态：源文件路径 */
  file?: string;
  /** file/line 形态：行号（正整数） */
  line?: number;
  /** bin 形态：covergroup bin 名 */
  bin?: string;
  /** 必填：豁免理由（人工审批依据） */
  reason: string;
  /** AI 置信度，∈ [0, 1] */
  confidence: number;
  /** 状态固定 pending：AI 只建议，审批只能人工触发 */
  status: 'pending';
  /** 来源固定 ai-triage */
  requestedBy: typeof EXCLUSION_REQUESTED_BY;
};

/** ```exclusion-suggestions 代码块提取正则（宽容匹配围栏后的语言标注） */
const SUGGESTION_BLOCK_RE = /```exclusion-suggestions\s*([\s\S]*?)```/;

/**
 * 从 AI 回复文本解析结构化 exclusion 建议块。
 *
 * 容错策略（解析失败返回空数组，不抛错——AI 输出不可信是常态）：
 * - 无 ```exclusion-suggestions 块 → 空数组
 * - 块内 JSON 畸形 → 空数组
 * - 单条建议缺 module / metric 非法 / 缺 reason / confidence ∉ [0,1] /
 *   file/line 与 bin 两种 selector 形态均缺失 → 跳过该条
 */
export function parseExclusionSuggestions(aiText: string): ExclusionSuggestion[] {
  const match = SUGGESTION_BLOCK_RE.exec(aiText);
  if (!match) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(match[1]);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.filter(isValidSuggestion).map((raw) => {
    const r = raw as Record<string, unknown>;
    return {
      module: r.module as string,
      metric: r.metric as CoverageMetric,
      file: typeof r.file === 'string' ? r.file : undefined,
      line: typeof r.line === 'number' ? r.line : undefined,
      bin: typeof r.bin === 'string' ? r.bin : undefined,
      reason: r.reason as string,
      confidence: r.confidence as number,
      status: 'pending' as const,
      requestedBy: EXCLUSION_REQUESTED_BY,
    };
  });
}

/** 单条建议结构校验（file/line 与 bin 至少一种形态完整）。 */
function isValidSuggestion(raw: unknown): boolean {
  if (!raw || typeof raw !== 'object') return false;
  const r = raw as Record<string, unknown>;
  if (typeof r.module !== 'string' || r.module.trim() === '') return false;
  if (typeof r.metric !== 'string' || !COVERAGE_METRICS.includes(r.metric as CoverageMetric)) {
    return false;
  }
  if (typeof r.reason !== 'string' || r.reason.trim() === '') return false;
  if (typeof r.confidence !== 'number' || !Number.isFinite(r.confidence)) return false;
  if (r.confidence < 0 || r.confidence > 1) return false;
  // selector 形态：file+line（line 为正整数）或 bin（非空字符串）
  const hasFileLine =
    typeof r.file === 'string' && r.file.trim() !== '' &&
    typeof r.line === 'number' && Number.isInteger(r.line) && r.line > 0;
  const hasBin = typeof r.bin === 'string' && r.bin.trim() !== '';
  return hasFileLine || hasBin;
}

/**
 * 注入 AI prompt 的 exclusion 说明片段（ADR 0026 决策 1）。
 *
 * 约束传达给 AI：
 * - 仅当判定 gap 根因为 dead_code / 不可达时输出该块，其余根因（缺测试/约束问题等）不输出
 * - reason 必填（人工审批的唯一依据）
 * - AI 任何情况下只能建议，不能自称已排除——排除必须经人工审批
 */
export function buildExclusionPromptSection(): string {
  return `## Coverage Exclusion 建议（可选输出）

当且仅当你判定某个 gap 的根因是 dead_code / 不可达代码（补测试无意义）时，
在回复末尾输出一个 \`\`\`exclusion-suggestions 代码块，给出结构化豁免建议。
根因为其他类型（缺测试、约束问题、复位缺失等）时**不要**输出该块。

代码块内容为 JSON 数组，每条建议字段：
- module: 模块在 Coverage Tree 中的路径（如 "tb_top.chip_top"）
- metric: 覆盖率指标（line | branch | toggle | condition | fsm_state | fsm_transition | functional | assertion）
- file / line: 源码定位形态——文件路径与行号（适用于 code metric 的行/分支排除）
- bin: covergroup bin 名形态（适用于 functional covergroup bin 排除）
- reason: **必填**。豁免理由，说明为什么该覆盖项不可达/为 dead code（人工审批的唯一依据）
- confidence: 你对该判断的置信度，0 到 1 的小数

示例：
\`\`\`exclusion-suggestions
[
  {
    "module": "tb_top.chip_top",
    "metric": "line",
    "file": "rtl/cpu_core.sv",
    "line": 142,
    "reason": "该分支受 power-down 门控，正常功能模式下不可达，仅 DFT 模式可激活",
    "confidence": 0.86
  },
  {
    "module": "tb_top.memory_ctrl",
    "metric": "functional",
    "bin": "err_inject.bin_backdoor",
    "reason": "backdoor 注入路径仅验证平台自检使用，前门访问永不触发",
    "confidence": 0.92
  }
]
\`\`\`

**安全底线：你只能提出建议（状态为 pending），任何情况下都不能声称已完成排除。
豁免只有经人工审批通过后才会生效。**`;
}
