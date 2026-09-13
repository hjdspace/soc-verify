/**
 * KB 短来源编译管线（issue 08/09，spec §4、§5）— 文字来源 → 两阶段模型调用
 * →（可选一次有界修复）→ 既有 staging。
 *
 * 职责边界（Smart zone M）：
 *  - 固定快照：任务绑定 kbId + 来源修订（sourceRef 由 manifest 固定，
 *    不接受模型输入）+ schema/purpose 快照（由 stageProposal 记 hash）；
 *  - 先简洁分析再生成（compile-prompts，无隐藏思维链）；
 *  - 读集：当前知识库目录（wiki/index.md）+ 必要既有页（本票以 index
 *    为上下文，跨来源正文合并待 issue 16）；
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
 * 模型调用边界：本模块不解析配置 —— 调用方（队列/测试）显式传入
 * CompileLlm（无凭证传 null），凭证不进入任务文件或渲染端。
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  parseFileProposal,
  filterTruncatedFileRepairOutput,
  normalizeProposalPath,
  checkTargetRoute,
  serializeProposalFiles,
  type ParsedProposalFile,
} from './proposal-blocks';
import { parseWikiPage } from './wiki-page';
import { parseWikiSchema, WIKI_PAGE_TYPES, DEFAULT_TYPE_DIRS } from './wiki-schema';
import { wikiLayout, readWikiManifest } from './wiki-layout';
import { readWikiParsed } from './source-import';
import { stageProposal } from './staging';
import { writeFileAtomic } from './atomic-commit';
import { callLlm, LlmCallError, type LlmUsage } from './llm-call';
import { resolveKbLlmConfig } from './llm-config';
import { buildAnalysisPrompt, buildGenerationPrompt, buildRepairPrompt } from './compile-prompts';
import type {
  WikiChangeSet,
  WikiPageType,
  WikiSourceRef,
  WikiStagingErrorCode,
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
 * 失败诊断（issue 09）：失败时保留已完成阶段、各阶段 usage、重试数、
 * 是否已用掉唯一一次修复，以及仍未补齐的既定路径。全部只含诊断信息，
 * 不含凭证。
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
};

export type CompileFailure = {
  ok: false;
  code: CompileErrorCode;
  message: string;
  diagnostics: CompileDiagnostics;
};

export type CompileResult = CompileSuccess | CompileFailure;

export type CompileInput = {
  kbId: string;
  /** 队列 taskId（staging 任务身份） */
  taskId: string;
  sourceId: string;
};

export type CompileDeps = {
  /** 模型入口；null = 未配置凭证 */
  llm: CompileLlm | null;
  /** 外部取消信号（队列取消/暂停共用） */
  signal?: AbortSignal;
  /** 注入时钟（测试用） */
  now?: string;
  /** 可重试失败的退避基数（毫秒，默认 1000；测试用 0 避免空等） */
  retryBaseDelayMs?: number;
};

/** 短来源全文上限（字符）。超限进入明确的 contextBudgetExceeded（分段编译待 issue 10）。 */
export const SHORT_SOURCE_MAX_CHARS = 40_000;

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

class CompileAborted extends Error {}

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
  /** 可读失败原因（ok=true 时为空串） */
  message: string;
  /** 失败是否属于「有界修复可救」（缺摘要页 / 流截断） */
  repairable: boolean;
};

/** 不完整性的可读描述（含应用固定的摘要页路径） */
function describeGaps(
  analysis: { missingSummary: boolean; truncated: string[] },
  summaryRelPath: string,
): string {
  const parts: string[] = [];
  if (analysis.missingSummary) {
    parts.push(`缺少必需的来源摘要页 ${summaryRelPath}（路径由应用固定）`);
  }
  if (analysis.truncated.length > 0) {
    parts.push(`提案存在未闭合块（流截断）: ${analysis.truncated.join('、')}`);
  }
  return parts.join('；');
}

/**
 * 判定提案是否可作为完整输出接受。
 *
 * 三类失败：
 *  - 结构性缺口（缺固定摘要页 / 未闭合块）→ repairable=true（有界修复可救）；
 *  - 归属违规（出现非本来源的来源页）→ 拒绝，不修复（不是截断伪影）；
 *  - 证据/格式违规（frontmatter 非法、sources 不含本来源 sourceRef）
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

  if (!hasSummary || parsed.truncated.length > 0) {
    const gaps = describeGaps({ missingSummary: !hasSummary, truncated: parsed.truncated }, summaryRelPath);
    return {
      ok: false,
      files: parsed.files,
      warnings: parsed.warnings,
      truncated: parsed.truncated,
      missingSummary: !hasSummary,
      message: `${gaps} — 拒绝接受不完整输出`,
      repairable: true,
    };
  }

  for (const file of parsed.files) {
    const page = parseWikiPage(file.content);
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
 * 计算有界修复的目标路径：仅「缺失的固定来源摘要页」+「沙箱内的未闭合块」。
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
  for (const raw of analysis.truncated) {
    const check = checkTargetRoute(raw, typeDirs);
    if (!check.ok) {
      warnings.push(`截断路径不在可写沙箱内，不作为修复目标: ${raw}`);
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

    // 预算：短来源全文直接进提示词；超限明确报错（长文档分段待 issue 10）
    if (parsedView.content.length > SHORT_SOURCE_MAX_CHARS) {
      return failWith(
        'contextBudgetExceeded',
        `来源全文 ${parsedView.content.length} 字符超过短来源编译上限 ${SHORT_SOURCE_MAX_CHARS}，分段编译待后续版本`,
      );
    }

    // 读集：purpose / schema / 当前知识库目录
    const purpose = await readFileOrNull(layout.purposeMdPath);
    const schema = await readFileOrNull(layout.schemaMdPath);
    const index = await readFileOrNull(join(kbPath, 'wiki', 'index.md'));
    const now = deps.now ?? new Date().toISOString();

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

    // ── 阶段 1：简洁结构化分析 ──
    throwIfAborted();
    const analysis = await invokePhase(llm, {
      system: ANALYSIS_SYSTEM,
      user: buildAnalysisPrompt({ purpose, schema, index, sourceContent: parsedView.content }),
      maxTokens: ANALYSIS_MAX_TOKENS,
    }, signal, baseDelayMs);
    retryCount += analysis.retryCount;
    if (!analysis.ok) {
      return failWith(analysis.code, analysis.message, { retryCount });
    }
    if (analysis.usage) usage.push(analysis.usage);
    completedPhases.push('analyzing');

    // ── 阶段 2：FILE 提案生成 ──
    throwIfAborted();
    const generation = await invokePhase(llm, {
      system: GENERATION_SYSTEM,
      user: buildGenerationPrompt({
        purpose,
        schema,
        index,
        analysis: analysis.text,
        sourceName: rec.sourcePath,
        sourceSummaryRelPath: summaryRelPath,
        sourceRefYaml,
        today: now,
        pageTypes,
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
    const extraWarnings: string[] = [...verdict.warnings];

    // finish_reason=length 是**原因**信号：修复目标仍只能来自结构（缺失/截断的既定路径），
    // 不能凭 length 凭空指定要补哪些页。结构无缺口时记录可见说明，不触发修复。
    const truncatedByLength = isLengthFinish(generation.finishReason);
    if (truncatedByLength && verdict.ok) {
      extraWarnings.push(
        '模型输出在长度上限处结束（finish_reason=length）：结构校验未发现缺失或未闭合块，按完整输出处理。',
      );
    }

    // ── 阶段 2.5：有界修复（至多 MAX_REPAIR_ATTEMPTS 次，仅缺失/截断的既定路径） ──
    let repairAttemptsUsed = 0;
    while (!verdict.ok && verdict.repairable && repairAttemptsUsed < MAX_REPAIR_ATTEMPTS) {
      const { targets, warnings: targetWarnings } = repairTargetsFrom(verdict, summaryRelPath, typeDirs);
      extraWarnings.push(...targetWarnings);
      // 没有可写沙箱内的既定路径 → 不请求修复（不扩大写入范围）
      if (targets.length === 0) break;

      throwIfAborted();
      repairAttemptsUsed += 1;
      repairAttempted = true;

      const reasons = targets.map((t) => (normalizeProposalPath(t) === normalizeProposalPath(summaryRelPath)
        ? '缺少必需的来源摘要页'
        : '上一版在流结束前未闭合（被截断）'));
      const repair = await invokePhase(llm, {
        system: REPAIR_SYSTEM,
        user: buildRepairPrompt({
          purpose,
          schema,
          index,
          analysis: analysis.text,
          sourceName: rec.sourcePath,
          sourceRefYaml,
          today: now,
          pageTypes,
          requestedPaths: targets,
          reasons,
        }),
        maxTokens: REPAIR_MAX_TOKENS,
      }, signal, baseDelayMs);
      retryCount += repair.retryCount;
      if (!repair.ok) {
        unresolvedPaths = dedupePaths([...targets, ...verdict.truncated]);
        return failWith(
          'llmFailed',
          `有界修复后仍不完整: ${describeGaps(verdict, summaryRelPath)}；修复调用失败: ${repair.message}`,
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
          `有界修复后仍不完整: 未补齐 ${unresolvedAfterRepair.join('、')} — 拒绝发布不完整输出`,
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
      ]);
      const message = verdict.repairable && repairAttempted
        ? `有界修复后仍不完整: ${verdict.message}`
        : verdict.message;
      return failWith('llmFailed', message, { retryCount, repairAttempted, unresolvedPaths });
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
    });
    if (!staged.ok) {
      return failWith(mapStagingError(staged.error.code), staged.error.message, { retryCount, repairAttempted });
    }
    completedPhases.push('validating');

    const changeSet = staged.value.changeSet;
    // 既有同页更新提示：跨来源正文合并能力待 issue 16
    if (changeSet.pages.some((p) => p.before !== null)) {
      changeSet.warnings.push(
        '提案包含既有同页更新：跨来源正文合并能力待后续版本，请逐 hunk 审阅确认。',
      );
      // staging 文件已写入 —— 补写一次把提示持久化（原子替换）
      await writeFileAtomic(
        join(layout.stagingDir, `${changeSet.changeSetId}.json`),
        JSON.stringify(changeSet, null, 2),
      );
    }

    return { ok: true, changeSet, usage, retryCount, repairAttempted };
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
