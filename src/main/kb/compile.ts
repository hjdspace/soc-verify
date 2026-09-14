/**
 * KB 来源编译管线（issue 08/09/10，spec §4、§5）— 来源 → 分析 → 两阶段模型调用
 * →（可选一次有界修复）→ 既有 staging。
 *
 * 职责边界（Smart zone M）：
 *  - 固定快照：任务绑定 kbId + 来源修订（sourceRef 由 manifest 固定，
 *    不接受模型输入）+ schema/purpose 快照（由 stageProposal 记 hash）；
 *  - 先简洁分析再生成（compile-prompts，无隐藏思维链）；
 *  - 读集：当前知识库目录（wiki/index.md）+ 必要既有页（本票以 index
 *    为上下文，跨来源正文合并在 staging 后按来源关系执行 issue 16）；
 *  - 输出只经既有 stageProposal（路径沙箱/frontmatter/归属固定），
 *    本模块不写 wiki/；
 *  - 坏输出必须拒绝：缺来源摘要页、伪造其他来源页、证据不符、未闭合块。
 *
 * 流完整度（issue 09）：
 *  - 生成缺少固定来源摘要页或存在未闭合块时，最多**一次**有界修复调用
 *    （`MAX_REPAIR_ATTEMPTS = 1`）；修复目标只能来自结构证据 ——
 *    「缺失的固定摘要页」+「可写沙箱内被截断的路径」，修复输出中出现的
 *    其他路径一律丢弃（见 filterTruncatedFileRepairOutput）。
 *    `finish_reason=length` 只作为**原因**信号记录/说明，不凭空指定目标。
 *  - 修复仍不完整（仍截断 / 漏项 / 调用失败）→ 报 llmFailed 并保留诊断
 *    （已完成阶段 / usage / 重试数 / 未补齐路径）；绝不发布 fallback 页
 *    冒充完整成功，也不把"部分补齐"当成功。
 *  - 认证/坏模型（401/403/404）不自动重试；网络/408/429/5xx 有界退避
 *    （最多 3 次尝试）并遵循 Retry-After。
 *  - 中止（外部 signal）优先于一切：不再修复、不写 staging、不写缓存，
 *    保留已完成阶段诊断。
 *
 * 长来源分段（issue 10，spec §4）：
 *  - 预算按「规则（system/schema/purpose/输出格式）+ 已有知识（index）+ 输出预留
 *    + 来源输入」统一计算，中文按 CJK 逐字符估算（不用英文的 4:1 比例）；
 *  - 超预算 → 按章节/原子证据分段（表格与围栏代码是原子证据，过大按行窗口
 *    分批并重复表头/保留原行号），逐段分析并**每段保存 checkpoint**；
 *  - 覆盖清单（行/章节/表格行/代码行覆盖数）随 changeSet.warnings 持久化，
 *    证明所有段落都处理过，末尾约束不会静默丢失；
 *  - checkpoint 键含来源修订/parsed 指纹、视觉指纹（本期 null）、schema/purpose、
 *    模型/提示版本与分块形状；**只恢复完全匹配的已完成段**，不匹配即重算；
 *  - 编译成功清除 checkpoint（它不是成功缓存，见 issue 17）；
 *  - 取消/失败保留已完成段（重试同任务只重做未完成段）；
 *  - 预算不足以放最小原子证据 → `contextBudgetExceeded`（队列显示为 blocked），
 *    绝不截掉参数表后继续。
 *
 * 模型调用边界：本模块不解析配置 —— 调用方（队列/测试）显式传入
 * CompileLlm（无凭证传 null），凭证不进入任务文件或渲染端。
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import {
  parseFileProposal,
  filterTruncatedFileRepairOutput,
  normalizeProposalPath,
  checkTargetRoute,
  serializeProposalFiles,
  type ParsedProposalFile,
} from './proposal-blocks';
import { parseWikiPage } from './wiki-page';
import { scanWikiCatalog } from './wiki-catalog';
import { parseWikiSchema, WIKI_PAGE_TYPES, DEFAULT_TYPE_DIRS } from './wiki-schema';
import { wikiLayout, readWikiManifest } from './wiki-layout';
import { readWikiParsed } from './source-import';
import { stageProposal } from './staging';
import { writeFileAtomic } from './atomic-commit';
import { callLlm, LlmCallError, type LlmUsage } from './llm-call';
import { resolveKbLlmConfig } from './llm-config';
import { readPdfAssetManifest } from './pdf-asset-store';
import {
  runVisionPhase,
  readVisionInterpretations,
  buildVisionAppendix,
  type VisionLlm,
} from './vision';
import {
  buildAnalysisPrompt,
  buildGenerationPrompt,
  buildRepairPrompt,
  buildChunkAnalysisPrompt,
  buildMergePrompt,
  parseChunkAnalysisOutput,
  CHUNK_ANALYSIS_PROMPT_VERSION,
  CHUNK_ANALYSIS_MAX_TOKENS,
} from './compile-prompts';
import { mergePageContent, type MergeFn, type MergeResult } from './page-merge';
import {
  computeCompileBudget,
  estimateTokens,
  formatBudgetSummary,
  truncateToTokens,
  DEFAULT_COMPILE_CONTEXT_TOKENS,
  GENERATION_OUTPUT_RESERVE_TOKENS,
  type CompileBudget,
} from './token-budget';
import { planLongSource, formatCoverageManifest, type SourceCoverage, type LongSourcePlan } from './long-source';
import type { PdfAssetRecord } from './pdf-assets';
import {
  longSourceCheckpointKey,
  loadLongSourceCheckpoint,
  saveLongSourceCheckpoint,
  clearLongSourceCheckpoint,
  LONG_SOURCE_CHECKPOINT_VERSION,
} from './long-source-checkpoint';
import {
  computeCacheFingerprint,
  checkCompileCache,
  checkRejection,
  type CompileCacheFingerprintInput,
} from './compile-cache';
import type {
  WikiChangeSet,
  WikiPageType,
  WikiSourceRef,
  WikiStagingErrorCode,
  WikiVisionGap,
  WikiVisionInterpretation,
} from '@shared/kb-types';

// ── 模型调用边界 ────────────────────────────────────────────────

/** 宽松调用结果（真实调用返回 LlmCallResult 超集兼容；测试可传字符串简写） */
export type LlmCallResultLike =
  | string
  | {
      text: string;
      finishReason?: string | null;
      usage?: LlmUsage | null;
    };

/** 编译用模型入口。调用方显式构造（真实凭证 / 可控假响应）；null = 无凭证。 */
export type CompileLlm = {
  /** 配置快照描述（仅供诊断，不写入任务文件） */
  readonly model: string;
  /** 模型上下文窗口（token）；缺省用 DEFAULT_COMPILE_CONTEXT_TOKENS */
  readonly contextTokens?: number;
  invoke: (req: { system: string; user: string; maxTokens: number }) => Promise<LlmCallResultLike>;
};

/**
 * 默认模型入口工厂（队列单例使用）。
 *
 * 每次 attempt 开始时调用一次 —— 在该次运行内固定配置快照
 * （baseUrl/model/凭证引用），解析结果由调用方显式传入编译管线；
 * 无可用凭证返回 null（任务以明确的 noCredential 失败）。
 * 凭证只存在于主进程内存中的 LlmConfig，不进入任务文件或渲染端。
 */
export function createDefaultCompileLlmFactory(): (signal: AbortSignal) => Promise<CompileLlm | null> {
  return async (signal) => {
    const config = await resolveKbLlmConfig();
    if (!config) return null;
    return {
      model: config.model,
      invoke: (req) => callLlm(config, {
        system: req.system,
        user: req.user,
        maxTokens: req.maxTokens,
        signal,
      }),
    };
  };
}

// ── 结果契约 ────────────────────────────────────────────────────

export type CompileErrorCode =
  | 'noCredential'
  | 'visionNotConfigured'
  | 'visionFailed'
  | 'visionBatchLimit'
  | 'sourceNotFound'
  | 'manifestCorrupted'
  | 'sourceNotReady'
  | 'contextBudgetExceeded'
  | 'aborted'
  | 'llmFailed'
  | 'schemaUnavailable'
  | 'invalidTarget'
  | 'ioError';

/** 编译阶段（失败诊断的「已完成阶段」；顺序即执行顺序） */
export type CompilePhase = 'analyzing' | 'generating' | 'repairing' | 'validating';

/**
 * 长来源分段信息（issue 10）：段数、本次实际分析与复用的段数、覆盖清单。
 * 覆盖清单同时写入 changeSet.warnings（人可核对「全部处理过」）。
 */
export type CompileChunking = CompileChunkProgress & {
  targetTokens: number;
  overlapTokens: number;
  coverage: SourceCoverage;
};

/** 分段进度（诊断与任务面板共用同一形状） */
export type CompileChunkProgress = {
  total: number;
  /** 本次运行实际分析（调用模型）的段数 */
  completed: number;
  /** 从第几段之后恢复（0 = 未复用 checkpoint） */
  resumedFrom: number;
};

/**
 * 失败诊断（issue 09/10）：失败时保留已完成阶段、各阶段 usage、重试数、
 * 是否已用掉唯一一次修复、仍未补齐的既定路径，以及预算分解与分段进度。
 * 全部只含诊断信息，不含凭证与来源正文。
 */
export type CompileDiagnostics = {
  completedPhases: CompilePhase[];
  /** 各阶段可获得的 usage（未返回 usage 的阶段不占位，不伪造 0） */
  usage: LlmUsage[];
  /** 模型调用内部有界退避的重试次数（本次运行累计） */
  retryCount: number;
  /** 是否已触发过唯一一次有界修复调用 */
  repairAttempted: boolean;
  /** 仍未补齐的既定路径（缺失的来源摘要页 / 未闭合块） */
  unresolvedPaths: string[];
  /** 预算分解（规则/已有知识/输出预留/可用输入）；未计算时为 null */
  budget: CompileBudget | null;
  /** 分段进度（长来源；未分段时为 null） */
  chunking: CompileChunkProgress | null;
};

/** 缓存命中（issue 17：已发布产出与指纹均有效，跳过 LLM 调用） */
export type CompileCacheHit = {
  ok: true;
  /** 命中的缓存条目 */
  cached: { sourceId: string; sourceRevision: string; publishedPageIds: string[]; publishedAt: string };
  /** 不调用模型，usage 为空 */
  usage: LlmUsage[];
  retryCount: number;
  repairAttempted: boolean;
  chunking: null;
};

export type CompileSuccess = {
  ok: true;
  changeSet: WikiChangeSet;
  /** 各阶段可获得的 usage（未返回 usage 的阶段不占位，不伪造 0） */
  usage: LlmUsage[];
  /** 模型调用内部有界退避的重试次数 */
  retryCount: number;
  /** 是否触发过一次有界修复调用 */
  repairAttempted: boolean;
  /** 长来源分段信息（单次编译为 null） */
  chunking: CompileChunking | null;
};

export type CompileFailure = {
  ok: false;
  code: CompileErrorCode;
  message: string;
  diagnostics: CompileDiagnostics;
};

export type CompileResult = CompileSuccess | CompileCacheHit | CompileFailure;

export type CompileInput = {
  kbId: string;
  /** 队列 taskId（staging 任务身份） */
  taskId: string;
  sourceId: string;
};

export type CompileDeps = {
  /** 模型入口；null = 未配置凭证 */
  llm: CompileLlm | null;
  /**
   * 视觉模型入口（issue 12）；缺省/null = 未配置视觉模型。
   * 来源含位图资产时：未配置且未显式 textOnly → visionNotConfigured 阻止编译
   * （不暗退回纯文字，spec §3）。
   */
  visionLlm?: VisionLlm | null;
  /**
   * 用户明确选择仅按文字继续（issue 12）：跳过视觉解读生成不完整提案，
   * changeSet 列出视觉缺口并标 partial —— 只有显式传入才生效。
   */
  textOnly?: boolean;
  /** 外部取消信号（队列取消/暂停共用） */
  signal?: AbortSignal;
  /** 注入时钟（测试用） */
  now?: string;
  /** 可重试失败的退避基数（毫秒，默认 1000；测试用 0 避免空等） */
  retryBaseDelayMs?: number;
  /** 分段进度回调（长来源：已完成段数/总段数；队列据此展示分段进度） */
  onChunkProgress?: (progress: { done: number; total: number }) => void;
  /** 逐张视觉解读进度回调（队列据此展示 vision 阶段进度与缓存命中） */
  onVisionProgress?: (progress: { done: number; total: number; reused?: number }) => void;
  /**
   * 编译内阶段切换回调（队列据此推进 phase 显示）：
   * 'vision' = 开始图像解读；'analyzing' = 进入文本分析。
   */
  onPhaseChange?: (phase: 'vision' | 'analyzing') => void;
  /**
   * 用户显式重编译（issue 17）：跳过缓存检查与拒绝记录，强制重新编译。
   * 队列的「重试」在缓存命中场景下默认不 force；用户点「重编译」才传 true。
   */
  force?: boolean;
};

/** 有界修复最多一次（spec §4：只允许一次有界修复调用） */
export const MAX_REPAIR_ATTEMPTS = 1;
/** 单次修复请求的目标路径上限（避免把整个提案重发一遍） */
export const MAX_REPAIR_TARGETS = 8;
/** 单阶段可重试失败的尝试上限（spec §5：网络/429 最多 3 次有界退避） */
export const LLM_MAX_ATTEMPTS = 3;

const ANALYSIS_MAX_TOKENS = 4_096;
const GENERATION_MAX_TOKENS = 8_192;
/** 修复必须重发完整页面正文 —— 复用较小预算会再次触发同一截断 */
const REPAIR_MAX_TOKENS = GENERATION_MAX_TOKENS;

const LLM_RETRY_BASE_DELAY_MS = 1_000;
const LLM_RETRY_MAX_DELAY_MS = 30_000;

const ANALYSIS_SYSTEM = '你是严谨的研究分析员。只输出最终结构化分析，不输出思考过程。';
const GENERATION_SYSTEM = '你是 wiki 维护者。只输出 FILE 块，不输出思考过程或其他文字。';
const REPAIR_SYSTEM = '你是 wiki 维护者。只补齐被请求的 FILE 块，每个块必须完整闭合，不输出其他内容。';
const CHUNK_ANALYSIS_SYSTEM = '你是严谨的研究分析员。只分析给定的这一段，输出「分块分析」与「全局摘要」两个小节，不输出思考过程。';
const MERGE_SYSTEM = '你是 wiki 维护者。只输出合并后的完整页面内容，不输出思考过程或其他文字。';

/**
 * 指令骨架的保守 token 预留（输出格式说明、frontmatter 规则、路由表等）。
 * 预算计算按「规则 + 已有知识 + 输出预留 + 来源输入」分解；此处把提示词骨架
 * 作为固定规则占用，避免把「可用输入」算得比实际更大。
 */
const PROMPT_SCAFFOLD = [
  GENERATION_SYSTEM,
  '## 页面类型与目录路由 ## 必须生成的内容 ## Frontmatter 规则 ## 正文要求 ## 输出格式',
  '---FILE: wiki/<类型目录>/<页面名>.md---',
  '（完整文件内容，含 YAML frontmatter）',
  '---END FILE---',
  '## 分析 ## 关键实体 ## 关键概念 ## 主要论断与证据 ## 与既有知识的关系 ## 建议生成的页面',
].join('\n');

class CompileAborted extends Error {}

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf-8').digest('hex');
}

async function readFileOrNull(path: string): Promise<string> {
  try {
    return await readFile(path, 'utf-8');
  } catch {
    return '';
  }
}

async function resultText(r: LlmCallResultLike): Promise<string> {
  return typeof r === 'string' ? r : r.text;
}

function resultUsage(r: LlmCallResultLike): LlmUsage | null {
  return typeof r === 'string' ? null : r.usage ?? null;
}

function resultFinishReason(r: LlmCallResultLike): string | null {
  return typeof r === 'string' ? null : r.finishReason ?? null;
}

/** 取消可中断的等待（退避期间中止不应挂住队列） */
async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(finish, ms);
    function finish(): void {
      clearTimeout(timer);
      signal?.removeEventListener('abort', finish);
      resolve();
    }
    signal?.addEventListener('abort', finish, { once: true });
  });
}

/** 退避时长：优先采信 Retry-After，否则指数退避（均有上限） */
function retryDelayMs(err: unknown, attempt: number, baseDelayMs: number): number {
  const suggested = err instanceof LlmCallError ? err.retryAfterMs : undefined;
  if (typeof suggested === 'number') return Math.min(suggested, LLM_RETRY_MAX_DELAY_MS);
  return Math.min(baseDelayMs * 2 ** (attempt - 1), LLM_RETRY_MAX_DELAY_MS);
}

/** 结束状态是否表示「被输出长度上限截断」 */
function isLengthFinish(finishReason: string | null): boolean {
  return finishReason === 'length' || finishReason === 'max_tokens';
}

type InvokePhaseResult =
  | {
      ok: true;
      text: string;
      finishReason: string | null;
      usage: LlmUsage | null;
      retryCount: number;
    }
  | { ok: false; code: CompileErrorCode; message: string; retryCount: number };

/**
 * 单阶段模型调用。
 *
 * 取消优先于一切错误（signal.aborted 一律收敛为 aborted）；
 * 可重试失败（LlmCallError.retryable：网络/超时/408/429/5xx/坏响应）
 * 做有界退避重试（最多 LLM_MAX_ATTEMPTS 次尝试，遵循 Retry-After）；
 * 认证/坏模型（不可重试）立即失败 —— 配置入口提示由 llm-call 统一注入。
 */
async function invokePhase(
  llm: CompileLlm,
  req: { system: string; user: string; maxTokens: number },
  signal: AbortSignal | undefined,
  baseDelayMs: number,
): Promise<InvokePhaseResult> {
  let lastMessage = '';
  let retryCount = 0;

  for (let attempt = 1; attempt <= LLM_MAX_ATTEMPTS; attempt += 1) {
    try {
      const r = await llm.invoke(req);
      if (signal?.aborted) return { ok: false, code: 'aborted', message: '编译已被取消', retryCount };
      return {
        ok: true,
        text: await resultText(r),
        finishReason: resultFinishReason(r),
        usage: resultUsage(r),
        retryCount,
      };
    } catch (err) {
      if (signal?.aborted) return { ok: false, code: 'aborted', message: '编译已被取消', retryCount };
      const retryable = err instanceof LlmCallError && err.retryable;
      lastMessage = err instanceof Error ? err.message : String(err);
      if (!retryable || attempt === LLM_MAX_ATTEMPTS) {
        return {
          ok: false,
          code: 'llmFailed',
          message: `模型调用失败: ${lastMessage}`,
          retryCount,
        };
      }
      retryCount += 1;
      await sleep(retryDelayMs(err, attempt, baseDelayMs), signal);
    }
  }

  return { ok: false, code: 'llmFailed', message: `模型调用失败: ${lastMessage}`, retryCount };
}

// ── 坏输出判定（staging 是权威校验；此处拦截明显坏输出避免脏 staging） ──

type ProposalAnalysis = {
  ok: boolean;
  /** 已闭合的块（即使整体判定失败也保留，供有界修复合并） */
  files: ParsedProposalFile[];
  warnings: string[];
  truncated: string[];
  missingSummary: boolean;
  /** 仅缺少标题/摘要、且来源证据校验通过的既有页。 */
  missingMetadata?: Array<{ path: string; message: string }>;
  /** 页面存在但缺少 frontmatter 围栏，允许定向补全。 */
  missingFrontmatter?: string[];
  /** 可读失败原因（ok=true 时为空串） */
  message: string;
  /** 失败是否属于「有界修复可救」（缺摘要页 / 流截断 / 缺页头或标题摘要） */
  repairable: boolean;
};

/** 不完整性的可读描述（含应用固定的摘要页路径） */
function describeGaps(
  analysis: Pick<ProposalAnalysis, 'missingSummary' | 'truncated' | 'missingMetadata' | 'missingFrontmatter'>,
  summaryRelPath: string,
): string {
  const parts: string[] = [];
  if (analysis.missingSummary) {
    parts.push(`缺少必需的来源摘要页 ${summaryRelPath}（路径由应用固定）`);
  }
  if (analysis.truncated.length > 0) {
    parts.push(`提案存在未闭合块（流截断）: ${analysis.truncated.join('、')}`);
  }
  for (const item of analysis.missingMetadata ?? []) parts.push(`${item.path}: ${item.message}`);
  for (const path of analysis.missingFrontmatter ?? []) parts.push(`${path}: 缺少 \`---\` 围栏的 frontmatter`);
  return parts.join('；');
}

/**
 * 判定提案是否可作为完整输出接受。
 *
 * 失败分类：
 *  - 结构性缺口（缺固定摘要页 / 未闭合块）→ repairable=true（有界修复可救）；
 *  - 归属违规（出现非本来源的来源页）→ 拒绝，不修复（不是截断伪影）；
 *  - 仅缺 title/summary 且证据合法 → 对原路径补全后重新校验；
 *  - 缺少 frontmatter 围栏 → 请求完整页头，修复后校验来源证据；
 *  - 其余证据/格式违规（frontmatter 非法、sources 不含本来源 sourceRef）
 *    → 拒绝，不修复（重试同一模型不会改变归属事实）。
 */
function analyzeProposal(
  text: string,
  summaryRelPath: string,
  sourceRef: WikiSourceRef,
): ProposalAnalysis {
  const parsed = parseFileProposal(text);
  if (!parsed.ok) {
    return {
      ok: false,
      files: [],
      warnings: [],
      truncated: [],
      missingSummary: false,
      message: `模型提案解析失败: ${parsed.error.message}`,
      repairable: false,
    };
  }

  const summaryKey = normalizeProposalPath(summaryRelPath);
  const hasSummary = parsed.files.some((f) => normalizeProposalPath(f.path) === summaryKey);

  // 归属由应用绑定：sources/ 下出现别的来源页即违规（模型不能为别的 source 伪造来源页）
  const foreignSourcePages = parsed.files
    .map((f) => f.path)
    .filter((p) => {
      const key = normalizeProposalPath(p);
      return key.startsWith('wiki/sources/') && key !== summaryKey;
    });
  if (foreignSourcePages.length > 0) {
    return {
      ok: false,
      files: parsed.files,
      warnings: parsed.warnings,
      truncated: parsed.truncated,
      missingSummary: !hasSummary,
      message: `提案包含非本来源的来源页（${foreignSourcePages.join('、')}），`
        + `应用固定的来源摘要页是 ${summaryRelPath} — 归属由应用绑定，拒绝接受`,
      repairable: false,
    };
  }

  const missingMetadata: NonNullable<ProposalAnalysis['missingMetadata']> = [];
  const missingFrontmatter: string[] = [];
  for (const file of parsed.files) {
    let page = parseWikiPage(file.content);
    if (!page.ok && page.issues.length === 1 && page.issues[0]?.code === 'missingFrontmatter') {
      missingFrontmatter.push(file.path);
      continue;
    }
    if (!page.ok && page.issues.every((i) => i.code === 'missingField' && (i.field === 'title' || i.field === 'summary'))) {
      missingMetadata.push({ path: file.path, message: page.issues.map((i) => i.message).join('；') });
      // 仅为校验其余字段（尤其来源归属）填入临时值；原文件始终保留，
      // 这些值不会进入模型提案或 staging，最终标题/摘要必须由补全返回。
      const validationFields = page.issues.map((i) => `${i.field}: "validation-only"`).join('\n');
      page = parseWikiPage(file.content.replace(/^(---[^\n]*\n)/, `$1${validationFields}\n`));
    }
    if (!page.ok) {
      return {
        ok: false,
        files: parsed.files,
        warnings: parsed.warnings,
        truncated: [],
        missingSummary: false,
        message: `提案页 frontmatter 非法: ${file.path} — ${page.issues.map((i) => i.message).join('；')}`,
        repairable: false,
      };
    }
    const bound = page.frontmatter.sources.some(
      (s) =>
        s.sourceId === sourceRef.sourceId
        && s.sourceRevision === sourceRef.sourceRevision
        && s.parsedHash === sourceRef.parsedHash,
    );
    if (!bound) {
      return {
        ok: false,
        files: parsed.files,
        warnings: parsed.warnings,
        truncated: [],
        missingSummary: false,
        message: `提案页证据与来源不符: ${file.path}（frontmatter sources 必须包含应用给定的 sourceRef）`,
        repairable: false,
      };
    }
  }

  if (!hasSummary || parsed.truncated.length > 0 || missingMetadata.length > 0 || missingFrontmatter.length > 0) {
    const gaps = { missingSummary: !hasSummary, truncated: parsed.truncated, missingMetadata, missingFrontmatter };
    return {
      ok: false, files: parsed.files, warnings: parsed.warnings, ...gaps,
      message: `${describeGaps(gaps, summaryRelPath)} — 拒绝接受不完整输出`,
      repairable: true,
    };
  }

  return {
    ok: true,
    files: parsed.files,
    warnings: parsed.warnings,
    truncated: [],
    missingSummary: false,
    message: '',
    repairable: false,
  };
}

/**
 * 计算有界修复目标：缺失的固定来源摘要页、沙箱内未闭合块和缺页头/标题/摘要页。
 * 沙箱外的截断路径不是既定目标，不请求修复（也不扩大写入范围）。
 */
function repairTargetsFrom(
  analysis: ProposalAnalysis,
  summaryRelPath: string,
  typeDirs: Record<WikiPageType, string>,
): { targets: string[]; warnings: string[] } {
  const warnings: string[] = [];
  const targets: string[] = [];
  const push = (path: string): void => {
    const key = normalizeProposalPath(path);
    if (targets.some((t) => normalizeProposalPath(t) === key)) return;
    targets.push(path);
  };

  if (analysis.missingSummary) push(summaryRelPath);
  for (const raw of [
    ...analysis.truncated,
    ...(analysis.missingMetadata ?? []).map((item) => item.path),
    ...(analysis.missingFrontmatter ?? []),
  ]) {
    const check = checkTargetRoute(raw, typeDirs);
    if (!check.ok) {
      warnings.push(`待补全路径不在可写沙箱内，不作为修复目标: ${raw}`);
      continue;
    }
    push(check.normalized);
  }

  if (targets.length > MAX_REPAIR_TARGETS) {
    const dropped = targets.slice(MAX_REPAIR_TARGETS);
    targets.length = MAX_REPAIR_TARGETS;
    warnings.push(
      `修复目标超过上限 ${MAX_REPAIR_TARGETS}，本次仅请求前 ${MAX_REPAIR_TARGETS} 个（其余保留为未补齐诊断）: ${dropped.join('、')}`,
    );
  }
  return { targets, warnings };
}

/** 合并原始已闭合块与修复块（修复块覆盖同名路径） */
function mergeProposalFiles(
  base: readonly ParsedProposalFile[],
  repaired: readonly ParsedProposalFile[],
): ParsedProposalFile[] {
  const merged = [...base];
  for (const file of repaired) {
    const key = normalizeProposalPath(file.path);
    const idx = merged.findIndex((x) => normalizeProposalPath(x.path) === key);
    if (idx >= 0) merged[idx] = file;
    else merged.push(file);
  }
  return merged;
}

/** staging 错误码 → 编译错误码 */
function mapStagingError(code: WikiStagingErrorCode): CompileErrorCode {
  if (code === 'schemaUnavailable') return 'schemaUnavailable';
  if (code === 'ioError') return 'ioError';
  return 'invalidTarget';
}

// ── 长来源分段分析（issue 10）────────────────────────────────────

type ChunkAnalysisResult =
  | {
      ok: true;
      /** 归并后的分析（逐段结论 + 最终全局摘要） */
      analysis: string;
      /** 覆盖清单文本（写入 changeSet.warnings，人可核对） */
      coverageManifest: string;
      /** 本次运行实际分析的段数 */
      completed: number;
      /** 从第几段之后恢复（0 = 未复用 checkpoint） */
      resumedFrom: number;
      /**
       * 可见告警：某段结论/摘要超出上界被裁剪时列出（**不静默丢失**）。
       * 来源原文从不被裁剪；被裁剪的是模型结论的超出部分。
       */
      warnings: string[];
      usage: LlmUsage[];
      retryCount: number;
    }
  | {
      ok: false;
      code: CompileErrorCode;
      message: string;
      completed: number;
      resumedFrom: number;
      usage: LlmUsage[];
      retryCount: number;
    };

/**
 * 分段分析长来源：逐段调用模型（带累计摘要与重叠上下文），每段完成后
 * 原子写入 checkpoint；中断/失败时已完成段保留，重试只重做未完成段。
 *
 * 只恢复**完全匹配**的 checkpoint（来源修订 / parsed 指纹 / schema / purpose /
 * 模型 / 提示版本 / 分块形状），不匹配即从第 1 段重算。
 */
async function analyzeInChunks(args: {
  kbPath: string;
  sourceId: string;
  llm: CompileLlm;
  signal: AbortSignal | undefined;
  baseDelayMs: number;
  modelFingerprint: string;
  plan: Extract<LongSourcePlan, { mode: 'chunked' }>;
  purpose: string;
  schema: string;
  index: string;
  sourceName: string;
  sourceRef: WikiSourceRef;
  availableInputTokens: number;
  /** 视觉附录指纹（issue 12；无附录为 null —— 键占位不改口径） */
  visionHash: string | null;
  /** 每次调用中累计摘要可占用的 token（由预算推导；超出即裁剪并告警） */
  digestMaxTokens: number;
  onChunkProgress?: (progress: { done: number; total: number }) => void;
}): Promise<ChunkAnalysisResult> {
  const { plan, sourceRef, kbPath, sourceId } = args;
  const total = plan.chunks.length;
  const usage: LlmUsage[] = [];
  let retryCount = 0;

  const { key, fingerprint } = longSourceCheckpointKey({
    sourceId,
    sourceRevision: sourceRef.sourceRevision,
    parsedHash: sourceRef.parsedHash,
    // 视觉附录指纹（issue 12）：解读变化 → 旧 checkpoint 失配重算
    visionHash: args.visionHash,
    schemaHash: sha256(args.schema),
    purposeHash: sha256(args.purpose),
    modelFingerprint: args.modelFingerprint,
    promptVersion: CHUNK_ANALYSIS_PROMPT_VERSION,
    chunkTargetTokens: plan.targetTokens,
    chunkOverlapTokens: plan.overlapTokens,
    chunks: plan.chunks,
  });

  const resumed = await loadLongSourceCheckpoint(kbPath, sourceId, { key, fingerprint, chunkTotal: total });
  const resumedFrom = resumed?.completedThrough ?? 0;
  let completedThrough = resumedFrom;
  let digest = resumed?.digest ?? '';
  const analyses: string[] = resumed ? [...resumed.analyses] : [];
  const warnings: string[] = [];
  /** 结论被裁剪的段号（可见告警，不静默丢失） */
  const trimmedChunks: number[] = [];

  args.onChunkProgress?.({ done: completedThrough, total });

  for (const chunk of plan.chunks) {
    if (chunk.index <= completedThrough) continue;
    if (args.signal?.aborted) {
      return {
        ok: false,
        code: 'aborted',
        message: `编译已被取消（第 ${completedThrough}/${total} 段已完成，checkpoint 已保留）`,
        completed: completedThrough,
        resumedFrom,
        usage,
        retryCount,
      };
    }

    const r = await invokePhase(args.llm, {
      system: CHUNK_ANALYSIS_SYSTEM,
      user: buildChunkAnalysisPrompt({
        purpose: args.purpose,
        schema: args.schema,
        index: args.index,
        sourceName: args.sourceName,
        chunk,
        digest,
        digestMaxTokens: args.digestMaxTokens,
      }),
      maxTokens: ANALYSIS_MAX_TOKENS,
    }, args.signal, args.baseDelayMs);
    retryCount += r.retryCount;
    if (!r.ok) {
      return {
        ok: false,
        code: r.code,
        message: `第 ${chunk.index}/${total} 段分析失败: ${r.message}`
          + `（已完成 ${completedThrough}/${total} 段，checkpoint 已保留，重试将从第 ${completedThrough + 1} 段继续）`,
        completed: completedThrough,
        resumedFrom,
        usage,
        retryCount,
      };
    }
    if (r.usage) usage.push(r.usage);

    const parsedOutput = parseChunkAnalysisOutput(r.text);
    if (estimateTokens(parsedOutput.analysis) > CHUNK_ANALYSIS_MAX_TOKENS) trimmedChunks.push(chunk.index);
    const section = truncateToTokens(parsedOutput.analysis, CHUNK_ANALYSIS_MAX_TOKENS);
    const nextDigest = truncateToTokens(parsedOutput.digest, args.digestMaxTokens);
    analyses.push([
      `## 第 ${chunk.index}/${total} 段（源行 ${chunk.startLine}-${chunk.endLine}`
        + `${chunk.headingPath ? `，章节「${chunk.headingPath}」` : ''}）`,
      section,
    ].join('\n'));
    digest = nextDigest || [digest, section].filter(Boolean).join('\n\n');
    completedThrough = chunk.index;

    await saveLongSourceCheckpoint(kbPath, sourceId, {
      version: LONG_SOURCE_CHECKPOINT_VERSION,
      fingerprint,
      key,
      completedThrough,
      digest,
      analyses: [...analyses],
      updatedAt: new Date().toISOString(),
    });
    args.onChunkProgress?.({ done: completedThrough, total });
  }

  const finalDigestRaw = digest;
  const finalDigest = truncateToTokens(finalDigestRaw, args.digestMaxTokens);
  if (finalDigest.length !== finalDigestRaw.length) {
    warnings.push(
      `跨段累计摘要超过每次调用的摘要上界 ${args.digestMaxTokens} tokens，已裁剪后进入后续提示词`
      + `（可提高模型上下文以避免裁剪）。`,
    );
  }
  if (trimmedChunks.length > 0) {
    warnings.push(
      `以下分段的结论超出单段结论上界 ${CHUNK_ANALYSIS_MAX_TOKENS} tokens 被裁剪（保留前段内容，未静默丢弃）：`
      + `${trimmedChunks.join('、')} —— 详细段落建议提高模型上下文后重编，或直接查看来源原文。`,
    );
  }
  const analysis = [
    `# 长来源分段分析（共 ${total} 段；源行 ${1}-${plan.coverage.totalLines}）`,
    '',
    '## 最终全局摘要',
    finalDigest || '（无摘要）',
    '',
    '## 逐段分析',
    analyses.join('\n\n'),
  ].join('\n');

  // 归并分析 + 覆盖清单必须能随生成提示词一起送入（生成输入 = 规则 + 已有知识
  // + 覆盖清单 + 归并分析，规则与已有知识已在可用输入中扣除）。放不下就明确
  // blocked —— 不静默裁掉某段结论来凑预算。
  const coverageManifest = formatCoverageManifest(plan);
  const generationInputTokens = estimateTokens(analysis) + estimateTokens(coverageManifest);
  if (generationInputTokens > args.availableInputTokens) {
    return {
      ok: false,
      code: 'contextBudgetExceeded',
      message: `分段分析结论与覆盖清单共 ${generationInputTokens} tokens，超过可用输入 ${args.availableInputTokens} tokens`
        + `（共 ${total} 段）—— 无法在不丢失段落结论的情况下生成提案，`
        + `请提高模型上下文或减少规则/既有页读入后重试；已完成段保留在 checkpoint。`,
      completed: completedThrough,
      resumedFrom,
      usage,
      retryCount,
    };
  }

  return {
    ok: true,
    analysis,
    coverageManifest,
    completed: completedThrough - resumedFrom,
    resumedFrom,
    warnings,
    usage,
    retryCount,
  };
}

// ── 公开接口 ────────────────────────────────────────────────────

/**
 * 编译一个已就绪来源：分析 → 生成 →（一次有界修复）→ staging。
 *
 * 前置：来源 status=ready 且 parsedRevision === currentRevision
 * （队列路径先跑 convertWikiSource 保证就绪）。
 * 成功返回持久化 changeSet（审阅入口见 kb.stagedChangeSet）；
 * 失败返回可解释诊断，绝不发布不完整输出。
 */
export async function compileWikiSource(
  kbPath: string,
  input: CompileInput,
  deps: CompileDeps,
): Promise<CompileResult> {
  const { signal } = deps;
  const baseDelayMs = deps.retryBaseDelayMs ?? LLM_RETRY_BASE_DELAY_MS;

  // 运行诊断（失败/中止时保留已完成阶段与 usage）
  const completedPhases: CompilePhase[] = [];
  const usage: LlmUsage[] = [];
  let retryCount = 0;
  let repairAttempted = false;
  let unresolvedPaths: string[] = [];
  let budget: CompileBudget | null = null;
  let chunkProgress: CompileChunkProgress | null = null;

  const failWith = (
    code: CompileErrorCode,
    message: string,
    overrides: Partial<Pick<CompileDiagnostics, 'retryCount' | 'repairAttempted' | 'unresolvedPaths'>> = {},
  ): CompileFailure => ({
    ok: false,
    code,
    message,
    diagnostics: {
      completedPhases: [...completedPhases],
      usage: [...usage],
      retryCount: overrides.retryCount ?? retryCount,
      repairAttempted: overrides.repairAttempted ?? repairAttempted,
      unresolvedPaths: overrides.unresolvedPaths ?? unresolvedPaths,
      budget,
      chunking: chunkProgress,
    },
  });

  const throwIfAborted = (): void => {
    if (signal?.aborted) throw new CompileAborted();
  };

  try {
    if (!deps.llm) {
      return failWith('noCredential', '未配置 LLM 凭证（设置 → 凭证管理），无法编译');
    }
    const llm = deps.llm;
    throwIfAborted();

    const layout = wikiLayout(kbPath);
    const read = await readWikiManifest(kbPath);
    if (!read.ok) {
      return failWith('manifestCorrupted', `库 manifest 不可读（${read.reason}）`);
    }
    const rec = read.manifest.sources?.[input.sourceId];
    if (!rec) {
      return failWith('sourceNotFound', `来源不存在: ${input.sourceId}`);
    }
    if (rec.status !== 'ready' || rec.parsedRevision !== rec.currentRevision || !rec.parsedHash) {
      return failWith('sourceNotReady', `来源尚未就绪（status=${rec.status}），无法编译: ${rec.sourcePath}`);
    }

    // 固定来源快照：修订 + parsed 指纹由应用从 manifest 读取
    const parsedView = await readWikiParsed(kbPath, { sourceId: input.sourceId });
    if (parsedView.parsedHash !== rec.parsedHash || parsedView.revision !== rec.currentRevision) {
      return failWith('sourceNotReady', `parsed 全文与 manifest 记录不一致: ${rec.sourcePath}`);
    }
    const sourceRef: WikiSourceRef = {
      sourceId: input.sourceId,
      sourceRevision: rec.currentRevision,
      parsedHash: rec.parsedHash,
    };

    // ── 编译缓存检查（issue 17，spec §4：增量跳过） ──
    // 重复导入或显式重编只重做失效工作；待审阅/拒绝/部分发布不冒充完整成功。
    // force=true（用户显式重编译）时跳过缓存与拒绝记录检查。
    if (!deps.force) {
      throwIfAborted();

      // 全拒绝记录检查：普通刷新不重新烧 token
      const rejection = await checkRejection(kbPath, input.sourceId, rec.currentRevision);
      if (rejection.rejected) {
        return {
          ok: true,
          cached: {
            sourceId: input.sourceId,
            sourceRevision: rec.currentRevision,
            publishedPageIds: [],
            publishedAt: rejection.entry.rejectedAt,
          },
          usage: [],
          retryCount: 0,
          repairAttempted: false,
          chunking: null,
        } satisfies CompileCacheHit;
      }

      // 缓存指纹检查
      const purposeForCache = await readFileOrNull(layout.purposeMdPath);
      const schemaForCache = await readFileOrNull(layout.schemaMdPath);
      const indexForCache = await readFileOrNull(join(kbPath, 'wiki', 'index.md'));
      // 已发布页面 pageId 列表（参与指纹）
      const scan = await scanWikiCatalog(kbPath);
      const publishedPageIds = scan.ok
        ? scan.catalog.pages.filter((p) => p.kind === 'page').map((p) => p.pageId)
        : [];
      const cacheInput: CompileCacheFingerprintInput = {
        sourceId: input.sourceId,
        sourceRevision: rec.currentRevision,
        parsedHash: rec.parsedHash,
        visionHash: null, // 视觉指纹在下方计算后更新；此处先 null，命中时视觉未变
        schemaHash: schemaForCache ? sha256(schemaForCache) : 'ABSENT',
        purposeHash: purposeForCache ? sha256(purposeForCache) : 'ABSENT',
        modelFingerprint: llm.model,
        readDependencyHash: sha256(indexForCache),
        publishedPageIds,
      };
      const cacheResult = await checkCompileCache(kbPath, cacheInput);
      if (cacheResult.hit) {
        return {
          ok: true,
          cached: {
            sourceId: input.sourceId,
            sourceRevision: rec.currentRevision,
            publishedPageIds: cacheResult.entry.publishedPageIds,
            publishedAt: cacheResult.entry.publishedAt,
          },
          usage: [],
          retryCount: 0,
          repairAttempted: false,
          chunking: null,
        } satisfies CompileCacheHit;
      }
    }

    // ── 视觉门禁（issue 12，spec §3：失败/未配置阻止完整编译，不暗退回纯文字）──
    const assetManifest = await readPdfAssetManifest(kbPath, input.sourceId, rec.currentRevision);
    const uniqueAssets: PdfAssetRecord[] = [];
    {
      const seen = new Set<string>();
      for (const a of assetManifest?.assets ?? []) {
        if (!seen.has(a.assetId)) {
          seen.add(a.assetId);
          uniqueAssets.push(a);
        }
      }
    }
    let visionGaps: WikiVisionGap[] = [];
    let visionAppendix = '';
    if (uniqueAssets.length > 0) {
      const existingRecords = (await readVisionInterpretations(kbPath, input.sourceId, rec.currentRevision)) ?? [];
      const okByAsset = new Map(
        existingRecords.filter((r) => r.status === 'ok').map((r) => [r.assetId, r] as const),
      );

      if (deps.textOnly) {
        // 用户明确选择仅按文字继续：跳过视觉解读，缺口随提案列出（不冒充完整编译）
        visionGaps = uniqueAssets
          .filter((a) => !okByAsset.has(a.assetId))
          .map((a) => ({
            assetId: a.assetId,
            page: a.page ?? null,
            reason: '用户选择仅按文字继续（该图未解读）',
          }));
        visionAppendix = buildVisionAppendix(
          uniqueAssets.map((a) => okByAsset.get(a.assetId)).filter((r): r is WikiVisionInterpretation => r !== undefined),
        );
      } else if (!deps.visionLlm) {
        return failWith(
          'visionNotConfigured',
          `来源包含 ${uniqueAssets.length} 张待解读图像，但未配置视觉模型`
            + '（设置 → 知识库 → 视觉模型）。配置并重试，或显式选择「仅按文字继续」'
            + '生成不完整提案（将列出视觉缺口并标部分产出）。',
        );
      } else {
        deps.onPhaseChange?.('vision');
        const vr = await runVisionPhase({
          kbPath,
          sourceId: input.sourceId,
          sourceRevision: rec.currentRevision,
          llm: deps.visionLlm,
          signal,
          onProgress: deps.onVisionProgress,
        });
        // 视觉阶段真实 usage 汇入编译诊断（issue 13：UI 报告真实用量，不伪造）
        if (vr.usage) usage.push(vr.usage);
        if (vr.cancelled) {
          return failWith('aborted', '图像解读已取消（已完成解读已保留，重试只重做剩余项）');
        }
        if (vr.failures.length > 0) {
          const first = vr.failures[0]!;
          const okCount = vr.stats.interpreted + vr.stats.reused;
          // 失败与批次上限同时发生时不能暗漏待处理页
          const pendingNote = vr.batchLimitReached
            ? `另有 ${vr.stats.pages.pending.length} 页因单批上限待处理。`
            : '';
          return failWith(
            'visionFailed',
            `图像解读失败 ${vr.failures.length}/${vr.stats.total} 张`
              + `（已成功 ${okCount} 张保留，重试只重做失败项）。`
              + `首个失败 [${first.errorCode}]: ${first.errorMessage}${pendingNote}`,
          );
        }
        if (vr.batchLimitReached) {
          // 单批页数上限（issue 13，spec §3）：不暗漏页 —— 待处理页可见，
          // 用户可重试继续下一批（已完成解读复用）或显式仅按文字继续缩小范围。
          const pendingPages = vr.stats.pages.pending;
          const pendingShown = pendingPages
            .slice(0, 10)
            .join(', ');
          return failWith(
            'visionBatchLimit',
            `图像解读达到单批页数上限（本批 ${vr.stats.pages.processed}/${vr.stats.pages.total} 页），`
              + `待处理页共 ${pendingPages.length} 页: ${pendingShown}${pendingPages.length > 10 ? '…' : ''}。`
              + `可重试任务继续下一批（已成功解读会复用，只处理待处理页），`
              + `或选择「仅按文字继续」缩小范围（剩余页将列为视觉缺口并标部分产出）。`,
          );
        }
        visionAppendix = buildVisionAppendix(vr.interpretations);
      }
    }

    // 附录进编译输入：预算按附录计入（不静默超出上下文）；
    // 机械 parsed 保持纯原文 —— 附录只存在于提示词与 .kb/vision 记录。
    const sourceWithVision = visionAppendix
      ? `${parsedView.content}\n\n${visionAppendix}`
      : parsedView.content;

    // 读集：purpose / schema / 当前知识库目录
    const purpose = await readFileOrNull(layout.purposeMdPath);
    const schema = await readFileOrNull(layout.schemaMdPath);
    const index = await readFileOrNull(join(kbPath, 'wiki', 'index.md'));
    const now = deps.now ?? new Date().toISOString();

    // 统一预算分解（spec §4）：规则 + 已有知识 + 输出预留 + 来源输入。
    // 中文按 CJK 逐字符估算，与英文不共用 chars/token 比例。
    budget = computeCompileBudget({
      contextTokens: llm.contextTokens ?? DEFAULT_COMPILE_CONTEXT_TOKENS,
      rulesText: [PROMPT_SCAFFOLD, schema, purpose].filter(Boolean).join('\n'),
      knowledgeText: index,
      outputReserveTokens: GENERATION_OUTPUT_RESERVE_TOKENS,
    });

    // 单次 / 分段 / blocked：预算不足放最小原子证据就明确 blocked，不裁掉参数表
    const plan = planLongSource(sourceWithVision, {
      availableInputTokens: budget.availableInputTokens,
    });
    if (plan.mode === 'blocked') {
      return failWith('contextBudgetExceeded', `${plan.reason}（${formatBudgetSummary(budget)}）`, { retryCount });
    }

    // schema 允许的页面类型与目录路由（schema 可解析则用其路由，否则固定八类）
    let pageTypes: readonly WikiPageType[] = WIKI_PAGE_TYPES;
    let typeDirs: Record<WikiPageType, string> = { ...DEFAULT_TYPE_DIRS };
    if (schema) {
      const s = parseWikiSchema(schema);
      if (s.ok) {
        const keys = Object.keys(s.routing.typeDirs) as WikiPageType[];
        if (keys.length > 0) {
          pageTypes = keys;
          typeDirs = s.routing.typeDirs;
        }
      }
    }

    const summaryRelPath = `wiki/sources/${input.sourceId}.md`;
    const sourceRefYaml = [
      'sources:',
      `  - sourceId: "${sourceRef.sourceId}"`,
      `    sourceRevision: "${sourceRef.sourceRevision}"`,
      `    parsedHash: "${sourceRef.parsedHash}"`,
    ].join('\n');

    // ── 阶段 1：结构化分析（预算内单次；超预算按章节分段 + checkpoint） ──
    throwIfAborted();
    deps.onPhaseChange?.('analyzing');
    const preWarnings: string[] = [];
    if (visionGaps.length > 0) {
      preWarnings.push(
        `部分产出：用户选择仅按文字继续，${visionGaps.length} 张图像未解读`
          + `（视觉缺口已随变更集列出；可配置视觉模型后重新编译补齐）。`,
      );
    }
    let analysisText: string;
    let chunking: CompileChunking | null = null;
    let coverageManifest: string | null = null;

    if (plan.mode === 'single') {
      const analysis = await invokePhase(llm, {
        system: ANALYSIS_SYSTEM,
        user: buildAnalysisPrompt({ purpose, schema, index, sourceContent: sourceWithVision }),
        maxTokens: ANALYSIS_MAX_TOKENS,
      }, signal, baseDelayMs);
      retryCount += analysis.retryCount;
      if (!analysis.ok) {
        return failWith(analysis.code, analysis.message, { retryCount });
      }
      if (analysis.usage) usage.push(analysis.usage);
      analysisText = analysis.text;
    } else {
      const chunked = await analyzeInChunks({
        kbPath,
        sourceId: input.sourceId,
        llm,
        signal,
        baseDelayMs,
        modelFingerprint: llm.model,
        plan,
        purpose,
        schema,
        index,
        sourceName: rec.sourcePath,
        sourceRef,
        availableInputTokens: budget.availableInputTokens,
        visionHash: visionAppendix ? sha256(visionAppendix) : null,
        digestMaxTokens: plan.digestTokens,
        onChunkProgress: deps.onChunkProgress,
      });
      retryCount += chunked.retryCount;
      usage.push(...chunked.usage);
      chunkProgress = { total: plan.chunks.length, completed: chunked.completed, resumedFrom: chunked.resumedFrom };
      if (!chunked.ok) {
        return failWith(chunked.code, chunked.message, { retryCount });
      }
      analysisText = chunked.analysis;
      // 覆盖清单进 changeSet.warnings：证明所有行/章节/原子证据都处理过
      coverageManifest = chunked.coverageManifest;
      preWarnings.push(chunked.coverageManifest);
      // 结论被裁剪时可见告警（来源原文从不裁剪；这里是模型结论的超出部分）
      preWarnings.push(...chunked.warnings);
      if (chunked.resumedFrom > 0) {
        preWarnings.push(
          `本次从已有 checkpoint 的第 ${chunked.resumedFrom + 1} 段继续（前 ${chunked.resumedFrom} 段已完成的结论直接复用，未重复调用模型）。`,
        );
      }
      chunking = {
        total: plan.chunks.length,
        completed: chunked.completed,
        resumedFrom: chunked.resumedFrom,
        targetTokens: plan.targetTokens,
        overlapTokens: plan.overlapTokens,
        coverage: plan.coverage,
      };
    }
    completedPhases.push('analyzing');

    // ── 阶段 2：FILE 提案生成 ──
    throwIfAborted();
    const generation = await invokePhase(llm, {
      system: GENERATION_SYSTEM,
      user: buildGenerationPrompt({
        purpose,
        schema,
        index,
        analysis: analysisText,
        sourceName: rec.sourcePath,
        sourceSummaryRelPath: summaryRelPath,
        sourceRefYaml,
        today: now,
        pageTypes,
        ...(coverageManifest && chunking
          ? { coverageManifest, chunkCount: chunking.total }
          : {}),
      }),
      maxTokens: GENERATION_MAX_TOKENS,
    }, signal, baseDelayMs);
    retryCount += generation.retryCount;
    if (!generation.ok) {
      return failWith(generation.code, generation.message, { retryCount });
    }
    if (generation.usage) usage.push(generation.usage);
    completedPhases.push('generating');

    // ── 坏输出判定 ──
    let verdict = analyzeProposal(generation.text, summaryRelPath, sourceRef);
    const extraWarnings: string[] = [...preWarnings, ...verdict.warnings];

    // finish_reason=length 是**原因**信号：修复目标仍只能来自结构（缺失/截断的既定路径），
    // 不能凭 length 凭空指定要补哪些页。结构无缺口时记录可见说明，不触发修复。
    const truncatedByLength = isLengthFinish(generation.finishReason);
    if (truncatedByLength && verdict.ok) {
      extraWarnings.push(
        '模型输出在长度上限处结束（finish_reason=length）：结构校验未发现缺失或未闭合块，按完整输出处理。',
      );
    }

    // ── 阶段 2.5：有界修复（至多 MAX_REPAIR_ATTEMPTS 次，仅已知缺口的既定路径） ──
    let repairAttemptsUsed = 0;
    while (!verdict.ok && verdict.repairable && repairAttemptsUsed < MAX_REPAIR_ATTEMPTS) {
      const { targets, warnings: targetWarnings } = repairTargetsFrom(verdict, summaryRelPath, typeDirs);
      extraWarnings.push(...targetWarnings);
      // 没有可写沙箱内的既定路径 → 不请求修复（不扩大写入范围）
      if (targets.length === 0) break;

      throwIfAborted();
      repairAttemptsUsed += 1;
      repairAttempted = true;

      const reasons = targets.map((t) => verdict.missingMetadata?.find((item) => normalizeProposalPath(item.path) === normalizeProposalPath(t))?.message
        ?? (verdict.missingSummary && normalizeProposalPath(t) === normalizeProposalPath(summaryRelPath)
          ? '缺少必需的来源摘要页'
          : verdict.missingFrontmatter?.some((path) => normalizeProposalPath(path) === normalizeProposalPath(t))
            ? '页面缺少 `---` 围栏的 frontmatter，请补齐完整页头'
            : '上一版在流结束前未闭合（被截断）'));
      const repair = await invokePhase(llm, {
        system: REPAIR_SYSTEM,
        user: buildRepairPrompt({
          purpose,
          schema,
          index,
          analysis: analysisText,
          sourceName: rec.sourcePath,
          sourceRefYaml,
          today: now,
          pageTypes,
          requestedPaths: targets,
          reasons,
          previousFiles: serializeProposalFiles(verdict.files.filter((file) =>
            targets.some((target) => normalizeProposalPath(target) === normalizeProposalPath(file.path)))),
        }),
        maxTokens: REPAIR_MAX_TOKENS,
      }, signal, baseDelayMs);
      retryCount += repair.retryCount;
      if (!repair.ok) {
        unresolvedPaths = dedupePaths([...targets, ...verdict.truncated]);
        return failWith(
          'llmFailed',
          `来源「${rec.sourcePath}」有界修复后仍不完整: ${describeGaps(verdict, summaryRelPath)}；修复调用失败: ${repair.message}`,
          { retryCount, repairAttempted: true, unresolvedPaths },
        );
      }
      if (repair.usage) usage.push(repair.usage);
      completedPhases.push('repairing');

      const filtered = filterTruncatedFileRepairOutput(repair.text, targets);
      extraWarnings.push(...filtered.warnings);

      // 修复必须覆盖**全部**请求目标：漏项/仍截断都不得放行 ——
      // 否则「部分补齐」会被当成完整成功发布出去。
      const provided = new Set(filtered.files.map((f) => normalizeProposalPath(f.path)));
      const stillMissing = targets.filter((t) => !provided.has(normalizeProposalPath(t)));
      const unresolvedAfterRepair = dedupePaths([...stillMissing, ...filtered.truncated]);
      if (unresolvedAfterRepair.length > 0) {
        unresolvedPaths = dedupePaths([...unresolvedAfterRepair, ...verdict.truncated]);
        return failWith(
          'llmFailed',
          `来源「${rec.sourcePath}」有界修复后仍不完整: 未补齐 ${unresolvedAfterRepair.join('、')} — 拒绝发布不完整输出`,
          { retryCount, repairAttempted: true, unresolvedPaths },
        );
      }

      verdict = analyzeProposal(
        serializeProposalFiles(mergeProposalFiles(verdict.files, filtered.files)),
        summaryRelPath,
        sourceRef,
      );
    }

    if (!verdict.ok) {
      unresolvedPaths = dedupePaths([
        ...(verdict.missingSummary ? [summaryRelPath] : []),
        ...verdict.truncated,
        ...(verdict.missingMetadata ?? []).map((item) => item.path),
        ...(verdict.missingFrontmatter ?? []),
      ]);
      const message = verdict.repairable && repairAttempted
        ? `有界修复后仍不完整: ${verdict.message}`
        : verdict.message;
      return failWith('llmFailed', `来源「${rec.sourcePath}」${message}`, { retryCount, repairAttempted, unresolvedPaths });
    }
    extraWarnings.push(...verdict.warnings);

    // ── 阶段 3：校验并落既有 staging（路径沙箱/frontmatter/归属固定） ──
    throwIfAborted();
    const proposalText = verdict.files.length > 0
      && repairAttempted
      ? serializeProposalFiles(verdict.files)
      : generation.text;
    const staged = await stageProposal(kbPath, {
      kbId: input.kbId,
      taskId: input.taskId,
      origin: 'compile',
      sourceRefs: [sourceRef],
      proposalText,
      fixedSourcePageId: `sources/${input.sourceId}`,
      extraWarnings: dedupeWarnings(extraWarnings),
      // 视觉缺口（issue 12）：仅文字继续时随提案持久化并标 partial
      ...(visionGaps.length > 0 ? { visionGaps } : {}),
    });
    if (!staged.ok) {
      return failWith(mapStagingError(staged.error.code), staged.error.message, { retryCount, repairAttempted });
    }
    completedPhases.push('validating');

    const changeSet = staged.value.changeSet;

    // ── 阶段 3.5：来源感知合并（issue 16，spec §4 合并策略） ──
    // 对每个 before !== null 的页面（既有同页更新），按来源关系合并：
    //  - 同来源修订 → 替换正文（撤回旧论断）
    //  - 跨来源合并 → LLM 正文合并 + 来源引用 union + 锁定字段回写
    // 合并失败时保留旧页并阻止该提案发布（spec §4：异常不覆盖旧页）。
    const pagesWithBefore = changeSet.pages.filter((p) => p.before !== null);
    if (pagesWithBefore.length > 0) {
      const nowForMerge = now;
      const mergeWarnings: string[] = [];
      const mergeUsages: LlmUsage[] = [];

      // LLM 合并入口：调用 buildMergePrompt 组装提示词，复用编译 Llm
      const mergeFn: MergeFn = async (existingContent, incomingContent, sourceFileName, mergeSignal) => {
        const mergeResult = await invokePhase(llm, {
          system: MERGE_SYSTEM,
          user: buildMergePrompt({ sourceName: sourceFileName, existingContent, incomingContent }),
          maxTokens: GENERATION_MAX_TOKENS,
        }, mergeSignal ?? signal, baseDelayMs);
        retryCount += mergeResult.retryCount;
        if (!mergeResult.ok) {
          throw new Error(`LLM 合并调用失败: ${mergeResult.message}`);
        }
        if (mergeResult.usage) mergeUsages.push(mergeResult.usage);
        return await resultText(mergeResult);
      };

      let anyMerged = false;
      let anyFailed = false;

      for (const page of changeSet.pages) {
        if (page.before === null) continue; // 新页跳过

        const mergeResult: MergeResult = await mergePageContent({
          incomingContent: page.proposed,
          existingContent: page.before,
          incomingSourceRef: sourceRef,
          merger: mergeFn,
          sourceFileName: rec.sourcePath,
          pagePath: page.relPath,
          now: nowForMerge,
          signal,
        });

        if (mergeResult.ok) {
          if (mergeResult.llmMerged) {
            anyMerged = true;
            mergeWarnings.push(
              `来源感知合并：${page.relPath} — 跨来源正文已由 LLM 合并（来源引用去重、锁定字段回写）。`,
            );
          } else {
            mergeWarnings.push(
              `来源感知合并：${page.relPath} — 同来源修订，正文已替换。`,
            );
          }
          // 更新 proposed 为合并后内容
          page.proposed = mergeResult.content;
          // 更新 sources 为合并后引用（去重后的）
          const mergedParse = parseWikiPage(mergeResult.content);
          if (mergedParse.ok) {
            page.sources = mergedParse.frontmatter.sources;
          }
        } else {
          anyFailed = true;
          // 合并失败：保留旧页（before 作为 proposed），阻止该提案发布
          mergeWarnings.push(
            `来源感知合并失败：${page.relPath} — ${mergeResult.message}（保留旧页，请人工审阅确认）。`,
          );
          // fallback 内容作为 proposed（保留旧页内容）
          if (mergeResult.fallback !== null) {
            page.proposed = mergeResult.fallback;
          }
        }
      }

      // 汇总合并阶段 usage
      usage.push(...mergeUsages);

      // 合并警告持久化
      changeSet.warnings.push(...dedupeWarnings(mergeWarnings));
      if (anyMerged) {
        changeSet.warnings.push(
          '提案包含跨来源 LLM 正文合并：已保留各来源贡献，来源引用去重，锁定字段回写。请逐 hunk 审阅合并结果。',
        );
      }
      if (anyFailed) {
        changeSet.warnings.push(
          '部分页面来源感知合并失败：相关页面保留旧内容，请人工审阅后决定是否接受。',
        );
      }

      // 持久化更新后的 changeSet（原子替换）
      await writeFileAtomic(
        join(layout.stagingDir, `${changeSet.changeSetId}.json`),
        JSON.stringify(changeSet, null, 2),
      );
    }

    // 编译成功：丢弃分段 checkpoint（未发布模型中间产物，不是成功缓存 —— 缓存属 issue 17）。
    // 失败/取消时保留，重试只重做未完成段。
    if (chunking) await clearLongSourceCheckpoint(kbPath, input.sourceId);

    // ── 编译缓存指纹（issue 17）：在视觉与合并完成后计算最终指纹，存入 changeSet。
    // 发布成功后 publish.ts 读取此指纹写入 compile-cache。
    const purposeForFp = await readFileOrNull(layout.purposeMdPath);
    const schemaForFp = await readFileOrNull(layout.schemaMdPath);
    const indexForFp = await readFileOrNull(join(kbPath, 'wiki', 'index.md'));
    const scanForFp = await scanWikiCatalog(kbPath);
    const publishedPageIdsForFp = scanForFp.ok
      ? scanForFp.catalog.pages.filter((p) => p.kind === 'page').map((p) => p.pageId)
      : [];
    changeSet.compileCacheFingerprint = computeCacheFingerprint({
      sourceId: input.sourceId,
      sourceRevision: rec.currentRevision,
      parsedHash: rec.parsedHash,
      visionHash: visionAppendix ? sha256(visionAppendix) : null,
      schemaHash: schemaForFp ? sha256(schemaForFp) : 'ABSENT',
      purposeHash: purposeForFp ? sha256(purposeForFp) : 'ABSENT',
      modelFingerprint: llm.model,
      readDependencyHash: sha256(indexForFp),
      publishedPageIds: publishedPageIdsForFp,
    });
    // 持久化带指纹的 changeSet（原子替换）
    await writeFileAtomic(
      join(layout.stagingDir, `${changeSet.changeSetId}.json`),
      JSON.stringify(changeSet, null, 2),
    );

    return { ok: true, changeSet, usage, retryCount, repairAttempted, chunking };
  } catch (err) {
    if (err instanceof CompileAborted) {
      return failWith('aborted', '编译已被取消（不再修复、不写 staging）');
    }
    return failWith('ioError', `编译过程异常: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** 路径去重（大小写/分隔符归一后比较，保留首个原始形态） */
function dedupePaths(paths: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of paths) {
    const key = normalizeProposalPath(p);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(p);
  }
  return out;
}

/** 警告去重（保持顺序，避免修复阶段重复告警刷屏） */
function dedupeWarnings(warnings: readonly string[]): string[] {
  return [...new Set(warnings)];
}
